import * as shell from "shelljs";
import OpenAI from "openai";
import { Octokit } from "@octokit/rest";
import * as dotenv from "dotenv";

dotenv.config();

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GPT_MODEL = "gpt-3.5-turbo-1106";

if (!OPENAI_API_KEY) {
  throw new Error(
    "The required OPENAI_API_KEY environment variable is not set."
  );
}

if (!GITHUB_TOKEN) {
  throw new Error("The required GITHUB_TOKEN environment variable is not set.");
}

const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
});

const octokit = new Octokit({
  auth: GITHUB_TOKEN,
});

async function getBranchInformation() {
  const currentBranch = shell
    .exec("git branch --show-current", { silent: true })
    .stdout.trim();
  const commits = shell.exec(
    `git log $(git merge-base ${currentBranch} main)..${currentBranch} --pretty=format:"%h %s"`,
    { silent: true }
  ).stdout;
  const diff = shell.exec(
    `git diff $(git merge-base ${currentBranch} main)..${currentBranch}`,
    { silent: true }
  ).stdout;

  if (!currentBranch) {
    throw new Error("Failed to determine the current git branch.");
  }
  if (!commits) {
    throw new Error("No commit history found for this branch.");
  }
  if (!diff) {
    throw new Error("No diff found for this branch.");
  }

  return { currentBranch, commits, diff };
}

async function generatePRDescription(commits: string, diff: string) {
  const response = await openai.chat.completions.create({
    model: GPT_MODEL,
    messages: [
      {
        content: `Generate a PR description in markdown format based on the following git commits and diff:\n\nCommits:\n${commits}\n\nDiff:\n${diff}`,
        role: "user",
      },
    ],
    temperature: 0.5,
    max_tokens: 1024,
  });

  const res = response.choices[0].message.content;
  if (!res) {
    throw new Error("OpenAI failed to generate PR description.");
  }
  return res.trim();
}

async function updateGitHubPRDescription(
  branch: string,
  prDescription: string
) {
  const { stdout: remoteUrl } = shell.exec(
    "git config --get remote.origin.url",
    { silent: true }
  );
  const repoPathMatch =
    /github.com[/:](?<owner>.+?)\/(?<repo>.+?)(\.git)?$/.exec(remoteUrl);
  if (!repoPathMatch || !repoPathMatch.groups) {
    throw new Error(
      "Could not determine the repository from the remote origin URL."
    );
  }
  const { owner, repo } = repoPathMatch.groups;

  const prs = await octokit.pulls.list({
    owner,
    repo,
    head: `${owner}:${branch}`,
  });

  if (prs.data.length === 0) {
    throw new Error(`No open PRs found for branch: ${branch}`);
  }

  const prNumber = prs.data[0].number;

  await octokit.pulls.update({
    owner,
    repo,
    pull_number: prNumber,
    body: prDescription,
  });

  console.log(`PR description updated successfully for PR #${prNumber}.`);
}

async function main() {
  try {
    const { currentBranch, commits, diff } = await getBranchInformation();
    const prDescription = await generatePRDescription(commits, diff);
    await updateGitHubPRDescription(currentBranch, prDescription);
  } catch (error) {
    console.error("Error:", error);
    process.exit(1);
  }
}

main();

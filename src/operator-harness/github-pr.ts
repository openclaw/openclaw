import { spawn } from "node:child_process";

type PullRequestSummary = {
  number: number;
  url: string;
  title: string;
  isDraft: boolean;
  headRefName: string;
};

function parseRepo(repoUrl: string) {
  const match = repoUrl.match(/github\.com[:/](.+?)\/(.+?)(?:\.git)?$/i);
  if (!match?.[1] || !match[2]) {
    throw new Error(`Unsupported GitHub repo URL: ${repoUrl}`);
  }
  return `${match[1]}/${match[2]}`;
}

async function runGh(args: string[], cwd: string) {
  const child = spawn("gh", args, {
    cwd,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    readStream(child.stdout),
    readStream(child.stderr),
    new Promise<number | null>((resolve) => child.once("close", resolve)),
  ]);
  if ((exitCode ?? 1) !== 0) {
    throw new Error(`gh ${args.join(" ")} failed: ${stderr || stdout}`);
  }
  return stdout.trim();
}

function readStream(stream: NodeJS.ReadableStream) {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    stream.on("error", reject);
    stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

export async function findPullRequestByBranch(input: {
  repoUrl: string;
  branchName: string;
  cwd: string;
}) {
  const repo = parseRepo(input.repoUrl);
  const json = await runGh(
    [
      "pr",
      "list",
      "--repo",
      repo,
      "--head",
      input.branchName,
      "--state",
      "open",
      "--json",
      "number,url,title,isDraft,headRefName",
    ],
    input.cwd,
  );
  const parsed = JSON.parse(json) as PullRequestSummary[];
  return parsed[0] ?? null;
}

export async function ensurePullRequest(input: {
  repoUrl: string;
  branchName: string;
  baseBranch: string;
  title: string;
  bodyFile: string;
  cwd: string;
  draft?: boolean;
}) {
  const repo = parseRepo(input.repoUrl);
  const existing = await findPullRequestByBranch(input);
  if (existing) {
    await runGh(
      [
        "pr",
        "edit",
        String(existing.number),
        "--repo",
        repo,
        "--title",
        input.title,
        "--body-file",
        input.bodyFile,
      ],
      input.cwd,
    );
    return existing;
  }
  const url = await runGh(
    [
      "pr",
      "create",
      "--repo",
      repo,
      ...(input.draft === false ? [] : ["--draft"]),
      "--base",
      input.baseBranch,
      "--head",
      input.branchName,
      "--title",
      input.title,
      "--body-file",
      input.bodyFile,
    ],
    input.cwd,
  );
  return {
    number: 0,
    url: url.split(/\r?\n/).find((line) => line.startsWith("https://")) ?? url,
    title: input.title,
    isDraft: input.draft !== false,
    headRefName: input.branchName,
  } satisfies PullRequestSummary;
}

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expect } from "vitest";
import { gitNullConfigPath } from "./git-exec.js";

const execFileAsync = promisify(execFile);

export async function gitResult(cwd: string, args: string[]) {
  return execFileAsync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: gitNullConfigPath(),
      GIT_TERMINAL_PROMPT: "0",
      GIT_TRACE2_EVENT: undefined,
      GIT_NO_LAZY_FETCH: "1",
      GIT_AUTHOR_NAME: "OpenClaw Test",
      GIT_AUTHOR_EMAIL: "openclaw-test@example.invalid",
      GIT_COMMITTER_NAME: "OpenClaw Test",
      GIT_COMMITTER_EMAIL: "openclaw-test@example.invalid",
    },
  }).then(
    ({ stdout }) => ({ code: 0, stdout: stdout.trim() }),
    (error: unknown) => ({ code: Number(asOptionalRecord(error)?.code) || -1, stdout: "" }),
  );
}

export async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await gitResult(cwd, args);
  expect(result.code).toBe(0);
  return result.stdout;
}

export async function repository(root: string): Promise<string> {
  const repo = path.join(root, "repo");
  await git(root, "init", "--template=", "-b", "main", repo);
  await git(repo, "config", "commit.gpgSign", "false");
  await fs.writeFile(path.join(repo, "README.md"), "base\n");
  await git(repo, "add", "README.md");
  await git(repo, "commit", "-m", "initial");
  return repo;
}

export async function partialClone(root: string) {
  const source = await repository(root);
  const origin = path.join(root, "origin.git");
  const clone = path.join(root, "clone");
  await git(root, "clone", "--bare", source, origin);
  await git(origin, "config", "uploadpack.allowFilter", "true");
  await git(origin, "config", "uploadpack.allowAnySHA1InWant", "true");
  await git(
    root,
    "clone",
    "--no-checkout",
    "--filter=blob:none",
    pathToFileURL(origin).href,
    clone,
  );
  const commit = await git(clone, "rev-parse", "HEAD");
  const objects = await git(
    clone,
    "rev-list",
    "--objects",
    "--missing=print",
    "--no-object-names",
    "--max-count=1",
    commit,
  );
  expect(objects.split("\n").filter((line) => line.startsWith("?")).length).toBe(1);
  return { clone, commit };
}

export async function traceStarts(file: string, command: string) {
  const rows = (await fs.readFile(file, "utf8")).trim().split("\n");
  return rows.flatMap((line) => {
    const entry = asOptionalRecord(JSON.parse(line));
    return entry?.event === "start" && Array.isArray(entry.argv) && entry.argv.includes(command)
      ? [entry]
      : [];
  });
}

export function settle<T>(operation: Promise<T>) {
  return operation.then(
    (value) => ({ rejected: false as const, value }),
    (error: unknown) => ({ rejected: true as const, error }),
  );
}

export async function exists(directory: string): Promise<boolean> {
  return fs.stat(directory).then(
    () => true,
    (error: unknown) => {
      if (asOptionalRecord(error)?.code === "ENOENT") {
        return false;
      }
      throw error;
    },
  );
}

export async function within<T>(
  pending: Promise<T>,
  timeoutMessage = "Git worker lifecycle wait timed out",
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(timeoutMessage)), 10_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function waitForLifecyclePoint(
  reached: Promise<unknown>,
  operation: Promise<unknown>,
  endedMessage: string,
  timeoutMessage?: string,
) {
  return within(
    Promise.race([
      reached,
      operation.then(() => {
        throw new Error(endedMessage);
      }),
    ]),
    timeoutMessage,
  );
}

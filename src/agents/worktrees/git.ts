import fs from "node:fs/promises";
import path from "node:path";
import { runCommandWithTimeout } from "../../process/exec.js";

const GIT_TIMEOUT_MS = 120_000;

export type GitResult = {
  stdout: string;
  stderr: string;
  code: number | null;
};

export type WorktreeListEntry = {
  path: string;
  lockedReason?: string;
};

export async function runGit(
  cwd: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; input?: string } = {},
): Promise<GitResult> {
  return await runCommandWithTimeout(["git", "-C", cwd, ...args], {
    timeoutMs: GIT_TIMEOUT_MS,
    env: options.env,
    input: options.input,
  });
}

export function commandError(command: string, result: GitResult): Error {
  const detail = (result.stderr || result.stdout).trim().split("\n").slice(-12).join("\n");
  return new Error(`${command} failed${detail ? `:\n${detail}` : ""}`);
}

export async function requireGit(
  cwd: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; input?: string } = {},
): Promise<string> {
  const result = await runGit(cwd, args, options);
  if (result.code !== 0) {
    throw commandError(`git ${args.join(" ")}`, result);
  }
  return result.stdout.trim();
}

export async function requireGitRaw(cwd: string, args: string[]): Promise<string> {
  const result = await runGit(cwd, args);
  if (result.code !== 0) {
    throw commandError(`git ${args.join(" ")}`, result);
  }
  return result.stdout;
}

export function parseWorktreeList(output: string): WorktreeListEntry[] {
  const entries: WorktreeListEntry[] = [];
  let current: WorktreeListEntry | undefined;
  for (const field of output.split("\0")) {
    if (!field) {
      if (current) {
        entries.push(current);
        current = undefined;
      }
      continue;
    }
    if (field.startsWith("worktree ")) {
      if (current) {
        entries.push(current);
      }
      current = { path: field.slice("worktree ".length) };
    } else if (current && field === "locked") {
      current.lockedReason = "";
    } else if (current && field.startsWith("locked ")) {
      current.lockedReason = field.slice("locked ".length);
    }
  }
  if (current) {
    entries.push(current);
  }
  return entries;
}

export async function listGitWorktrees(repoRoot: string): Promise<WorktreeListEntry[]> {
  return parseWorktreeList(
    await requireGitRaw(repoRoot, ["worktree", "list", "--porcelain", "-z"]),
  );
}

export async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.lstat(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export async function removeEmptyParents(start: string, stop: string): Promise<void> {
  let current = start;
  while (current.startsWith(`${stop}${path.sep}`)) {
    try {
      await fs.rmdir(current);
    } catch {
      return;
    }
    current = path.dirname(current);
  }
}

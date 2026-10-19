import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
export const readText = (root: string, name: string) => fs.readFile(path.join(root, name), "utf8");

export async function git(cwd: string, ...args: string[]) {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  return stdout.trimEnd();
}

export async function initializeRepository(
  root: string,
  prepare?: (repo: string) => Promise<void>,
) {
  const repo = path.join(root, "source");
  await fs.mkdir(repo, { recursive: true });
  await git(repo, "init", "-b", "main");
  await git(repo, "config", "user.name", "OpenClaw Test");
  await git(repo, "config", "user.email", "openclaw-test@example.invalid");
  await fs.writeFile(path.join(repo, "README.md"), "base\n");
  await prepare?.(repo);
  await git(repo, "add", ".");
  await git(repo, "commit", "-m", "initialize managed worktree fixture");
  return { repo: await fs.realpath(repo), baseCommit: await git(repo, "rev-parse", "HEAD") };
}

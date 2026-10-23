import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
export const gitIdentity = [
  "-c",
  "user.name=OpenClaw Test",
  "-c",
  "user.email=openclaw-test@example.invalid",
];
export async function git(cwd: string, ...args: string[]) {
  return (await exec("git", ["-C", cwd, ...args])).stdout.trim();
}

export async function initializeGitFixture(root: string, name: string, file: string, text: string) {
  const repo = path.join(root, name);
  await git(root, "init", "--template=", "-b", "main", repo);
  await git(repo, "config", "user.name", "OpenClaw Test");
  await git(repo, "config", "user.email", "openclaw-test@example.invalid");
  await git(repo, "config", "commit.gpgSign", "false");
  await fs.writeFile(path.join(repo, file), text);
  await git(repo, "add", file);
  await git(repo, "commit", "-m", "initial");
  return repo;
}

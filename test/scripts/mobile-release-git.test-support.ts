import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export function git(root: string, ...args: string[]) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

export function write(root: string, file: string, text: string) {
  const target = path.join(root, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, text);
}

export function initGit(root: string, options: { name: string; email: string; branch?: string }) {
  fs.mkdirSync(root, { recursive: true });
  git(root, "init", "-b", options.branch ?? "main");
  git(root, "config", "user.name", options.name);
  git(root, "config", "user.email", options.email);
  git(root, "config", "commit.gpgsign", "false");
}

export function commit(root: string, message: string, ...files: string[]) {
  git(root, "add", ...(files.length ? files : ["."]));
  git(root, "commit", "-m", message);
  return git(root, "rev-parse", "HEAD");
}

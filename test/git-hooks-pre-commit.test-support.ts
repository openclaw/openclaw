import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { makeTempDir as makeTempRepoRoot } from "./helpers/temp-dir.js";

const baseGitEnv = {
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  GIT_CONFIG_COUNT: "4",
  GIT_CONFIG_KEY_0: "user.name",
  GIT_CONFIG_VALUE_0: "Hook Test",
  GIT_CONFIG_KEY_1: "user.email",
  GIT_CONFIG_VALUE_1: "hook@example.invalid",
  GIT_CONFIG_KEY_2: "commit.gpgSign",
  GIT_CONFIG_VALUE_2: "false",
  GIT_CONFIG_KEY_3: "init.templateDir",
  GIT_CONFIG_VALUE_3: "",
};
export const rulePath = ".git/private rules.txt";
export const ruleSetting = "hooks.blockedLiteralsFile";
export const literals = ["GUARD_SYNTHETIC_ALPHA", "GUARD_SYNTHETIC_BETA_[x].*42"] as const;

export const run = (cwd: string, cmd: string, args: string[] = [], env?: NodeJS.ProcessEnv) =>
  execFileSync(cmd, args, {
    cwd,
    encoding: "utf8",
    stdio: "pipe",
    timeout: 20_000,
    maxBuffer: 24 * 1024 * 1024,
    env: {
      PATH: process.env.PATH,
      HOME: cwd,
      TMPDIR: cwd,
      LC_ALL: "C",
      TZ: "UTC",
      ...baseGitEnv,
      ...env,
    },
  }).trim();

export const runFailure = (...args: Parameters<typeof run>) => {
  try {
    run(...args);
  } catch (error) {
    if (!(error instanceof Error) || !("status" in error)) {
      throw error;
    }
    const failure = error as Error & {
      status?: number;
      stderr?: string;
      stdout?: string;
    };
    return {
      status: failure.status ?? 1,
      stderr: failure.stderr ?? "",
      stdout: failure.stdout ?? "",
    };
  }

  throw new Error("expected command to fail");
};

export function writeExecutable(dir: string, name: string, contents: string): void {
  fs.writeFileSync(path.join(dir, name), contents, { mode: 0o755 });
}

export function installPreCommitFixture(dir: string): string {
  const at = (...names: string[]) => path.join(dir, ...names);
  for (const name of ["git-hooks", "scripts/pre-commit", "node_modules/.bin", "bin"]) {
    fs.mkdirSync(at(name), { recursive: true });
  }
  fs.symlinkSync(
    path.join(process.cwd(), "git-hooks", "pre-commit"),
    at("git-hooks", "pre-commit"),
  );
  for (const name of [
    "run-node-tool.sh",
    "filter-staged-files.mjs",
    "guard-staged-content.mjs",
    "format-staged.sh",
  ]) {
    fs.copyFileSync(
      path.join(process.cwd(), "scripts/pre-commit", name),
      at("scripts/pre-commit", name),
    );
  }
  // Freshness checks import repository planners; hook behavior tests isolate formatting and guards.
  fs.writeFileSync(at("scripts/pre-commit/check-staged-freshness.mts"), "");
  const privateRules = path.resolve(
    dir,
    run(dir, "git", ["rev-parse", "--git-path", "private rules.txt"]),
  );
  fs.writeFileSync(privateRules, `${literals.join("\n")}\n`, { mode: 0o600 });
  run(dir, "git", ["config", "--local", ruleSetting, privateRules]);
  // Stdin mode must echo the blob or the hook treats the empty output as formatter failure.
  writeExecutable(
    at("node_modules/.bin"),
    "oxfmt",
    '#!/bin/sh\ncase "$*" in *--stdin-filepath=*) cat ;; esac\nexit 0\n',
  );

  return at("bin");
}

export function createContentGuardFixture(tempDirs: string[]): string {
  const dir = makeTempRepoRoot(tempDirs, "openclaw-content-guard-");
  run(dir, "git", ["init", "-q", "--initial-branch=main"]);
  installPreCommitFixture(dir);
  return dir;
}

export function stageContent(dir: string, name: string, content: string | Buffer): void {
  fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
  fs.writeFileSync(path.join(dir, name), content);
  run(dir, "git", ["--literal-pathspecs", "add", "-f", "--", name]);
}

export const commitArgs = ["-c", "core.hooksPath=git-hooks", "commit", "-qm", "guard proof"];

export function installFormattingRecorder(dir: string, body = ""): string {
  const logPath = path.join(dir, "hook-tool.log");
  writeExecutable(
    path.join(dir, "node_modules/.bin"),
    "oxfmt",
    `#!/usr/bin/env bash
set -euo pipefail
printf 'oxfmt %s\n' "$*" >> hook-tool.log
case "$*" in *--stdin-filepath=*) cat ;; esac
${body}
`,
  );
  return logPath;
}

export function readFormatterLog(logPath: string): string[] {
  return fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8").split("\n").filter(Boolean) : [];
}

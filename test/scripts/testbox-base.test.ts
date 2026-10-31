import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import { devNull } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { parse } from "yaml";
import { createTempDirTracker } from "../helpers/temp-dir.js";
import { createScriptTestHarness } from "./test-helpers.js";

const { createTempDir } = createScriptTestHarness();
const seedDirs = createTempDirTracker();
let source: string;
let eventBase: string;
let mainBase: string;
type Step = {
  run?: string;
  env?: Record<string, string>;
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

beforeAll(() => {
  source = seedDirs.make("openclaw-testbox-source-");
  git(source, "init", "-q", "--initial-branch=main");
  git(source, "config", "user.name", "Test User");
  git(source, "config", "user.email", "test@example.com");
  for (const action of ["git-owner", "ensure-base-commit", "prepare-testbox-shell"]) {
    fs.cpSync(`.github/actions/${action}`, path.join(source, ".github/actions", action), {
      recursive: true,
    });
  }
  fs.mkdirSync(path.join(source, "scripts/lib"), { recursive: true });
  for (const helper of ["merge-head-diff-base.mjs", "arg-utils.runtime.mjs"]) {
    fs.copyFileSync(`scripts/lib/${helper}`, path.join(source, "scripts/lib", helper));
  }
  const commit = (label: string) => {
    git(source, "add", ".");
    git(source, "commit", "-qm", label);
    return git(source, "rev-parse", "HEAD");
  };
  eventBase = commit("base");
  git(source, "switch", "-q", "-c", "feature");
  fs.writeFileSync(path.join(source, "feature.txt"), "feature\n");
  commit("feature");
  git(source, "switch", "-q", "main");
  fs.writeFileSync(path.join(source, "main.txt"), "main\n");
  mainBase = commit("main advanced");
  git(source, "merge", "--no-ff", "feature", "-m", "synthetic merge");
});

afterAll(() => seedDirs.cleanup());

function runBasePreparation(repo: string, base: string, eventName: string) {
  const bin = createTempDir("openclaw-testbox-tools-");
  // System-wide Node links are unrelated to Git preparation and must stay fixture-local.
  fs.writeFileSync(
    path.join(bin, "sudo"),
    '#!/bin/sh\nif [ "$1" = tee ]; then cat >/dev/null; fi\n',
  );
  fs.chmodSync(path.join(bin, "sudo"), 0o755);
  const actionPath = path.join(repo, ".github/actions/prepare-testbox-shell");
  const action = parse(fs.readFileSync(path.join(actionPath, "action.yml"), "utf8"));
  const actionStep: Step = action.runs.steps[0];
  if (!actionStep.run) {
    throw new Error("Missing Testbox preparation command");
  }
  return spawnSync("bash", ["-euo", "pipefail", "-c", actionStep.run], {
    cwd: repo,
    encoding: "utf8",
    env: {
      ...process.env,
      ...Object.fromEntries(
        Object.entries(actionStep.env ?? {}).map(([key, value]) => [
          key,
          value.replace(
            "${{ inputs.base-ref }}",
            eventName === "workflow_dispatch" ? "HEAD" : base,
          ),
        ]),
      ),
      PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
      RUNNER_OS: process.platform === "win32" ? "Windows" : "Linux",
      GITHUB_ACTION_PATH: actionPath,
      GITHUB_EVENT_NAME: eventName,
      GITHUB_BASE_REF: "main",
      GIT_CONFIG_GLOBAL: devNull,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_ALLOW_PROTOCOL: "",
    },
  });
}

it.each([
  ["merge", "main", 2, "pull_request"],
  ["linear", "feature", 2, "pull_request"],
  ["merge without parents", "main", 1, "pull_request"],
  ["manual", "feature", 1, "workflow_dispatch"],
] as const)("pins the correct base in a %s checkout", (shape, branch, depth, eventName) => {
  const repo = createTempDir("openclaw-testbox-shallow-");
  git(
    source,
    "clone",
    "--quiet",
    "--no-local",
    `--depth=${depth}`,
    "--branch",
    branch,
    source,
    repo,
  );
  expect(git(repo, "rev-parse", "--is-shallow-repository")).toBe("true");
  expect(
    spawnSync("git", ["cat-file", "-e", `${eventBase}^{commit}`], { cwd: repo }).status === 0,
  ).toBe(branch === "feature" && depth > 1);
  const before = spawnSync("git", ["rev-parse", "refs/remotes/origin/main"], {
    cwd: repo,
    encoding: "utf8",
  });
  const result = runBasePreparation(repo, eventBase, eventName);
  if (shape === "merge without parents") {
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("Base commit still unavailable");
    expect(git(repo, "rev-parse", "refs/remotes/origin/main")).toBe(before.stdout.trim());
    return;
  }
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  expect(git(repo, "rev-parse", "refs/remotes/origin/main")).toBe(
    eventName === "workflow_dispatch"
      ? git(repo, "rev-parse", "HEAD")
      : branch === "main"
        ? mainBase
        : eventBase,
  );
});

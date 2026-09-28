import { spawnSync } from "node:child_process";
import { mkdirSync, realpathSync, symlinkSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
function fixture() {
  const campaignRoot = realpathSync(tempDirs.make("openclaw-qa-checkpoint-"));
  const checkpointRoot = path.join(campaignRoot, "checkpoint.git");
  const nodeRoot = path.join(campaignRoot, "node");
  for (const root of [checkpointRoot, nodeRoot]) {
    mkdirSync(root);
  }
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: campaignRoot,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: os.devNull,
  };
  // Captured product command shapes from the failing BC038 boundary.
  const init = [
    "git",
    "-c",
    `core.hooksPath=${os.devNull}`,
    "-c",
    "core.fsmonitor=false",
    "-C",
    checkpointRoot,
    "init",
    "--quiet",
    "--bare",
    "--object-format=sha1",
  ];
  const probe = [
    "git",
    "config",
    "--local",
    "--includes",
    "--bool",
    "--default=false",
    "--get",
    "extensions.worktreeConfig",
  ];
  const request = { campaignRoot, checkpointRoot, nodeRoot, cwd: nodeRoot, argv: init, env };
  const git = (argv: string[], cwd = nodeRoot) =>
    spawnSync("git", argv.slice(1), { cwd, env, encoding: "utf8" });
  expect(git(["git", "init", "--quiet", "--template=", nodeRoot]).status).toBe(0);
  const bin = path.join(campaignRoot, "bin");
  mkdirSync(bin);
  const trace = path.join(campaignRoot, "git-starts");
  writeFileSync(trace, "");
  // Observe the actual executable boundary, then replace this process with real
  // Git. A denied command must never enter this executable.
  const realGit = spawnSync("which", ["git"], { encoding: "utf8" }).stdout.trim();
  writeFileSync(
    path.join(bin, "git"),
    `#!/bin/sh\nprintf 'spawn\\n' >> '${trace}'\nexec '${realGit}' "$@"\n`,
    { mode: 0o700 },
  );
  const launch = (overrides: Partial<typeof request> = {}) =>
    spawnSync(
      process.execPath,
      ["--import", "./scripts/tsx.mjs", "scripts/qa/repository-checkpoint-admission.ts"],
      {
        input: JSON.stringify({ ...request, ...overrides }),
        env: { ...env, PATH: `${bin}${path.delimiter}${env.PATH ?? ""}` },
        encoding: "utf8",
      },
    );
  const starts = () => readFileSync(trace, "utf8").split("\n").filter(Boolean).length;
  return { request, init, probe, git, launch, starts };
}

it.skipIf(process.platform === "win32")(
  "admits the canonical checkpoint and publication reads through real Git",
  () => {
    const { request, init, probe, git, launch, starts } = fixture();
    const initialized = launch();
    expect(initialized.status, initialized.stderr).toBe(0);
    expect(starts()).toBe(1);
    expect(
      git(["git", "rev-parse", "--is-bare-repository"], request.checkpointRoot).stdout.trim(),
    ).toBe("true");
    const query = [...init.slice(0, 7), "rev-parse", "--git-dir"];
    expect(launch({ argv: query }).stdout.trim()).toBe(".");
    const result = launch({ argv: probe });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("false");
    expect(starts()).toBe(3);
  },
);

it.skipIf(process.platform === "win32")(
  "adds no authority for other Git writes, roots, aliases, or redirections",
  () => {
    const { request, init, probe, launch, starts } = fixture();
    const denied = (overrides: Partial<typeof request>) => {
      const result = launch(overrides);
      expect(result.status, result.stderr).toBe(126);
      expect(starts()).toBe(0);
    };
    for (const argv of [
      ["git", "push", "origin", "HEAD"],
      ["git", "update-ref", "--stdin", "-z"],
      ["git", "fast-import", "--quiet"],
      ["git", "config", "--local", "core.hooksPath", "/tmp"],
      [...init, "extra.git"],
      [...probe, "true"],
      [...init.slice(0, 7), "init", "--bare"],
    ]) {
      denied({ argv });
    }
    denied({ argv: probe, cwd: request.checkpointRoot });
    denied({ env: { ...request.env, GIT_DIR: request.checkpointRoot } });
    // The campaign refreshed its current placement. An argv captured from its old
    // root must not execute, even though that old directory still exists and is owned.
    const currentRoot = path.join(request.campaignRoot, "current.git");
    mkdirSync(currentRoot);
    denied({ checkpointRoot: currentRoot });
    const alias = path.join(request.campaignRoot, "alias.git");
    symlinkSync(request.checkpointRoot, alias, "dir");
    const redirected = (checkpointRoot: string) => ({
      ...request,
      checkpointRoot,
      argv: init.map((value) => (value === request.checkpointRoot ? checkpointRoot : value)),
    });
    denied(redirected(alias));
    denied(redirected(path.dirname(request.campaignRoot)));
    denied(redirected(path.join(request.campaignRoot, "missing")));
  },
);

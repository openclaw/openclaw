import { spawnSync } from "node:child_process";
import { mkdirSync, realpathSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { admitQaRepositoryCheckpointCommand } from "../../scripts/qa/repository-checkpoint-admission.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
function fixture() {
  const campaignRoot = realpathSync(tempDirs.make("openclaw-qa-checkpoint-"));
  const checkpointRoot = path.join(campaignRoot, "checkpoint.git");
  const nodeRoot = path.join(campaignRoot, "node");
  for (const root of [checkpointRoot, nodeRoot]) {
    mkdirSync(root);
  }
  const env = {
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
  return { request, init, probe, git };
}

it("admits the canonical checkpoint and publication reads through real Git", () => {
  const { request, init, probe, git } = fixture();
  expect(admitQaRepositoryCheckpointCommand(request)).toBe(true);
  expect(git(init).status).toBe(0);
  expect(
    git(["git", "rev-parse", "--is-bare-repository"], request.checkpointRoot).stdout.trim(),
  ).toBe("true");
  const query = [...init.slice(0, 7), "rev-parse", "--git-dir"];
  expect(admitQaRepositoryCheckpointCommand({ ...request, argv: query })).toBe(true);
  expect(git(query).stdout.trim()).toBe(".");
  expect(admitQaRepositoryCheckpointCommand({ ...request, argv: probe })).toBe(true);
  const result = git(probe);
  expect(result.status).toBe(0);
  expect(result.stdout.trim()).toBe("false");
});

it("adds no authority for other Git writes, roots, aliases, or redirections", () => {
  const { request, init, probe } = fixture();
  for (const argv of [
    ["git", "push", "origin", "HEAD"],
    ["git", "update-ref", "--stdin", "-z"],
    ["git", "fast-import", "--quiet"],
    ["git", "config", "--local", "core.hooksPath", "/tmp"],
    [...init, "extra.git"],
    [...probe, "true"],
    [...init.slice(0, 7), "init", "--bare"],
  ]) {
    expect(admitQaRepositoryCheckpointCommand({ ...request, argv })).toBe(false);
  }
  expect(
    admitQaRepositoryCheckpointCommand({ ...request, argv: probe, cwd: request.checkpointRoot }),
  ).toBe(false);
  expect(
    admitQaRepositoryCheckpointCommand({ ...request, env: { GIT_DIR: request.checkpointRoot } }),
  ).toBe(false);
  const alias = path.join(request.campaignRoot, "alias.git");
  symlinkSync(request.checkpointRoot, alias, "dir");
  const redirected = (checkpointRoot: string) => ({
    ...request,
    checkpointRoot,
    argv: init.map((value) => (value === request.checkpointRoot ? checkpointRoot : value)),
  });
  expect(admitQaRepositoryCheckpointCommand(redirected(alias))).toBe(false);
  expect(admitQaRepositoryCheckpointCommand(redirected(path.dirname(request.campaignRoot)))).toBe(
    false,
  );
  expect(
    admitQaRepositoryCheckpointCommand(redirected(path.join(request.campaignRoot, "missing"))),
  ).toBe(false);
});

import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, symlinkSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const admissionArgs =
  "--import ./scripts/tsx.mjs scripts/qa/repository-checkpoint-admission.ts".split(" ");
function fixture() {
  const campaignRoot = realpathSync(tempDirs.make("openclaw-qa-checkpoint-"));
  const checkpointRoot = mkdtempSync(path.join(campaignRoot, "checkpoint.git-"));
  const nodeRoot = mkdtempSync(path.join(campaignRoot, "node-"));
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: campaignRoot,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: os.devNull,
  };
  // Captured BC038 commands, independent of the production argument builder.
  const guards = ["-c", `core.hooksPath=${os.devNull}`, "-c", "core.fsmonitor=false"];
  const prefix = ["git", ...guards, "-C", checkpointRoot];
  const init = [...prefix, ..."init --quiet --bare --object-format=sha1".split(" ")];
  const probe =
    "git config --local --includes --bool --default=false --get extensions.worktreeConfig".split(
      " ",
    );
  const request = { campaignRoot, checkpointRoot, nodeRoot, cwd: nodeRoot, argv: init, env };
  const git = (argv: string[], cwd = nodeRoot) =>
    spawnSync("git", argv.slice(1), { cwd, env, encoding: "utf8" });
  expect(git(["git", "init", "--quiet", "--template=", nodeRoot]).status).toBe(0);
  const bin = mkdtempSync(path.join(campaignRoot, "bin-"));
  const trace = path.join(campaignRoot, "git-starts");
  writeFileSync(trace, "");
  // A denied command must never enter the traced real-Git executable.
  const realGit = spawnSync("/bin/sh", ["-c", "command -v git"], {
    encoding: "utf8",
  }).stdout.trim();
  writeFileSync(
    path.join(bin, "git"),
    `#!/bin/sh\nprintf 'spawn\\n' >> '${trace}'\nexec '${realGit}' "$@"\n`,
    { mode: 0o700 },
  );
  const launch = (overrides: Partial<typeof request> = {}) =>
    spawnSync(process.execPath, admissionArgs, {
      input: JSON.stringify({ ...request, ...overrides }),
      env: { ...env, PATH: `${bin}${path.delimiter}${env.PATH ?? ""}` },
      encoding: "utf8",
    });
  const starts = () => readFileSync(trace, "utf8").split("\n").filter(Boolean).length;
  return { request, prefix, init, probe, git, launch, starts };
}

it.skipIf(process.platform === "win32")("admits checkpoint init and publication reads", () => {
  const { request, prefix, probe, git, launch, starts } = fixture();
  const initialized = launch();
  expect([initialized.status, starts()], initialized.stderr).toEqual([0, 1]);
  expect(
    git(["git", "rev-parse", "--is-bare-repository"], request.checkpointRoot).stdout.trim(),
  ).toBe("true");
  const query = [...prefix, "rev-parse", "--git-dir"];
  expect(launch({ argv: query }).stdout.trim()).toBe(".");
  const result = launch({ argv: probe });
  expect([result.status, result.stdout.trim(), starts()]).toEqual([0, "false", 3]);
});

it.skipIf(process.platform === "win32")("denies writes, redirected and escaped roots", () => {
  const { request, prefix, init, probe, launch, starts } = fixture();
  const denied = (overrides: Partial<typeof request>) => {
    const result = launch(overrides);
    expect([result.status, starts()], result.stderr).toEqual([126, 0]);
  };
  for (const argv of [
    ["git", "push", "origin", "HEAD"],
    ["git", "update-ref", "--stdin", "-z"],
    ["git", "fast-import", "--quiet"],
    ["git", "config", "--local", "core.hooksPath", "/tmp"],
    [...init, "extra.git"],
    [...probe, "true"],
    [...prefix, "init", "--bare"],
  ]) {
    denied({ argv });
  }
  denied({ argv: probe, cwd: request.checkpointRoot });
  denied({ env: { ...request.env, GIT_DIR: request.checkpointRoot } });
  // Stale argv cannot authorize an old, still-owned campaign placement.
  const currentRoot = mkdtempSync(path.join(request.campaignRoot, "current.git-"));
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
});

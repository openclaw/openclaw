import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { resolveBuildIdentityEnvironment } from "../../scripts/lib/build-identity.mts";
import {
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerUrl,
} from "../../src/infra/runtime-worker-url.js";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { toolingProbeRuntimeEntrypoints } from "./tooling-probe-runtime.test-support.mts";

const buildIdentityUrl = resolveRuntimeWorkerUrl(toolingProbeRuntimeEntrypoints.buildIdentity);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const testNodeExecPath = resolveTestNodeExecPath();
const sha = (digit: string) => digit.repeat(40);

function readGitCommitInChild(cwd: string, env: NodeJS.ProcessEnv = process.env) {
  const result = spawnSync(
    testNodeExecPath,
    [
      ...resolveRuntimeWorkerArgv(buildIdentityUrl, testNodeExecPath).slice(0, -1),
      "--input-type=module",
      "--eval",
      `const { readCurrentGitCommit } = await import(${JSON.stringify(buildIdentityUrl.href)}); process.stdout.write(JSON.stringify(readCurrentGitCommit()));`,
    ],
    {
      cwd,
      encoding: "utf8",
      env,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10_000,
    },
  );
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as string | null;
}

it("reads HEAD from the inherited cwd and returns null when Git cannot resolve it", () => {
  const root = tempDirs.make("openclaw-build-identity-");
  const repo = join(root, "repo");
  const outsideRepo = join(root, "outside");
  mkdirSync(repo);
  mkdirSync(outsideRepo);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
  git("init", "-q");
  git("config", "user.name", "OpenClaw Tests");
  git("config", "user.email", "openclaw-tests@example.invalid");
  git("commit", "--allow-empty", "-qm", "fixture");
  const expected = git("rev-parse", "HEAD").trim();

  expect(readGitCommitInChild(repo)).toBe(expected);
  expect(readGitCommitInChild(outsideRepo)).toBeNull();

  const envWithoutGit = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([key]) => key.toLowerCase() !== "path"),
    ),
    PATH: "",
  };
  expect(readGitCommitInChild(repo, envWithoutGit)).toBeNull();
});

it.each([
  [{ GIT_COMMIT: sha("A"), GIT_SHA: sha("b") }, sha("D"), { GIT_COMMIT: sha("a") }, 0],
  [{ GIT_SHA: sha("B"), GITHUB_SHA: sha("c") }, sha("D"), { GIT_COMMIT: sha("b") }, 0],
  [{ GITHUB_SHA: sha("c") }, sha("D"), { GIT_COMMIT: sha("d") }, 1],
  [
    { GITHUB_SHA: "e".repeat(40), OPENCLAW_BUILD_TIMESTAMP: " 2026-07-10T01:02:03.000Z " },
    null,
    { GIT_COMMIT: "e".repeat(40), OPENCLAW_BUILD_TIMESTAMP: "2026-07-10T01:02:03.000Z" },
    1,
  ],
  [
    { GIT_COMMIT: "deadbeef" },
    null,
    new Error("runtime pack commit must be a full 40-character hexadecimal SHA"),
    0,
  ],
] as const)("resolves build identity %#", (env, checkout, expected, reads) => {
  const readGitCommit = vi.fn(() => checkout);
  const resolve = () =>
    resolveBuildIdentityEnvironment({
      env,
      readGitCommit,
      commitLabel: "runtime pack commit",
      now: () => new Date("2026-07-11T12:34:56.000Z"),
    });
  if (expected instanceof Error) {
    expect(resolve).toThrow(expected);
  } else {
    expect(resolve()).toMatchObject(expected);
  }
  expect(readGitCommit).toHaveBeenCalledTimes(reads);
});

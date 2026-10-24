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
const resolveIdentity = (options: Partial<Parameters<typeof resolveBuildIdentityEnvironment>[0]>) =>
  resolveBuildIdentityEnvironment({
    commitLabel: "runtime pack commit",
    readGitCommit: () => null,
    now: () => new Date("2026-07-11T12:34:56.000Z"),
    ...options,
  });

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
  [{ GIT_COMMIT: "A".repeat(40), GIT_SHA: "b".repeat(40) }, "a".repeat(40), false],
  [{ GIT_SHA: "B".repeat(40), GITHUB_SHA: "c".repeat(40) }, "b".repeat(40), false],
  [{ GITHUB_SHA: "c".repeat(40) }, "d".repeat(40), true],
])("preserves build source precedence %#", (env, expected, readsCheckout) => {
  const readGitCommit = vi.fn(() => "D".repeat(40));
  const resolved = resolveIdentity({
    commitLabel: "build commit",
    env,
    readGitCommit,
  });

  expect(resolved.GIT_COMMIT).toBe(expected);
  expect(readGitCommit).toHaveBeenCalledTimes(readsCheckout ? 1 : 0);
});

it("uses workflow identity only when the checkout cannot be read", () => {
  expect(
    resolveIdentity({
      env: {
        GITHUB_SHA: "e".repeat(40),
        OPENCLAW_BUILD_TIMESTAMP: " 2026-07-10T01:02:03.000Z ",
      },
    }),
  ).toMatchObject({
    GIT_COMMIT: "e".repeat(40),
    OPENCLAW_BUILD_TIMESTAMP: "2026-07-10T01:02:03.000Z",
  });
});

it("uses the owner label in malformed commit diagnostics", () => {
  expect(() => resolveIdentity({ env: { GIT_COMMIT: "deadbeef" } })).toThrow(
    "runtime pack commit must be a full 40-character hexadecimal SHA",
  );
});

import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  normalizeBuildTimestamp,
  resolveBuildInfo,
  writeBuildInfo,
} from "../../scripts/write-build-info.ts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const sha = "a".repeat(40);
const timestamp = "2026-07-10T12:34:56.000Z";
function createPackage() {
  const rootDir = tempDirs.make("openclaw-build-info-");
  fs.writeFileSync(path.join(rootDir, "package.json"), '{"version":"2026.7.10"}\n');
  return rootDir;
}
const unavailableGit = () => {
  throw new Error("git unavailable");
};
const resolve = (env: NodeJS.ProcessEnv, execFileSync: () => string = unavailableGit) =>
  resolveBuildInfo({ rootDir: createPackage(), env, execFileSync, now: () => new Date(timestamp) });

it.each([false, true])("writes normalized provenance (release=%s)", (release) => {
  const rootDir = createPackage();
  const execFileSync = vi.fn(unavailableGit);
  const output = writeBuildInfo({
    rootDir,
    execFileSync,
    env: {
      GIT_COMMIT: sha.toUpperCase(),
      OPENCLAW_BUILD_TIMESTAMP: "2026-07-10T12:34:56Z",
      ...(release ? { OPENCLAW_CONTROL_UI_RELEASE_BUILD: "1" } : {}),
    },
  });
  expect(execFileSync).not.toHaveBeenCalled();
  expect(path.relative(rootDir, output)).toBe("dist/build-info.json");
  expect(JSON.parse(fs.readFileSync(output, "utf8"))).toEqual({
    version: "2026.7.10",
    commit: sha,
    builtAt: timestamp,
    buildId: `2026.7.10-${release ? "release-" : ""}aaaaaaaaaaaa-2026-07-10T12-34-56.000Z`,
  });
});

it.each([
  [{}, null],
  [{ GIT_SHA: sha }, sha],
  [{ GITHUB_SHA: sha }, sha],
])("resolves provenance without Git: %j", (env, expected) => {
  expect(resolve(env).commit).toBe(expected);
});

it("prefers the checked-out commit to workflow context", () => {
  const execFileSync = vi.fn(() => "b".repeat(40));
  expect(resolve({ GITHUB_SHA: sha }, execFileSync).commit).toBe("b".repeat(40));
  expect(execFileSync).toHaveBeenCalledOnce();
});

it.each([
  [{ GIT_COMMIT: "bad", GIT_SHA: sha }, "GIT_COMMIT"],
  [{ GITHUB_SHA: "bad" }, "GITHUB_SHA"],
])("rejects malformed %j rather than falling back", (env, source) => {
  expect(() => resolve(env)).toThrow(`${source} must be a full 40-character Git commit SHA.`);
});

it.each([
  ["2026-07-10T12:34:56+00:00", "an ISO-8601 UTC timestamp ending in Z"],
  ["2026-02-30T12:34:56Z", "a valid ISO-8601 UTC timestamp"],
])("rejects invalid timestamp %s", (value, reason) => {
  expect(() => normalizeBuildTimestamp(value)).toThrow(
    `OPENCLAW_BUILD_TIMESTAMP must be ${reason}.`,
  );
});
it("normalizes fractional UTC timestamps", () => {
  expect(normalizeBuildTimestamp("2026-07-10T12:34:56.7Z")).toBe("2026-07-10T12:34:56.700Z");
});

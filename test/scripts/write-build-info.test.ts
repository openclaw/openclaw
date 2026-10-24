import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  normalizeBuildCommit,
  normalizeBuildTimestamp,
  resolveBuildInfo,
  writeBuildInfo,
} from "../../scripts/write-build-info.ts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

describe("write-build-info", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  function createPackage(): string {
    const rootDir = tempDirs.make("openclaw-build-info-");
    fs.writeFileSync(path.join(rootDir, "package.json"), '{"version":"2026.7.10"}\n');
    return rootDir;
  }
  const resolve = (options: Parameters<typeof resolveBuildInfo>[0]) =>
    resolveBuildInfo({
      rootDir: createPackage(),
      now: () => new Date("2026-07-10T01:02:03.000Z"),
      ...options,
    });
  const unavailableGit = () => {
    throw new Error("git unavailable");
  };

  it("normalizes explicit release provenance and writes the shared manifest", () => {
    const rootDir = createPackage();
    const execFileSync = vi.fn(() => {
      throw new Error("Git fallback should not run");
    });

    const outputPath = writeBuildInfo({
      rootDir,
      env: {
        GIT_COMMIT: "ABCDEF0123456789ABCDEF0123456789ABCDEF01",
        OPENCLAW_BUILD_TIMESTAMP: "2026-07-10T12:34:56Z",
      },
      execFileSync,
    });

    expect(execFileSync).not.toHaveBeenCalled();
    expect(path.relative(rootDir, outputPath)).toBe("dist/build-info.json");
    expect(JSON.parse(fs.readFileSync(outputPath, "utf8"))).toEqual({
      version: "2026.7.10",
      commit: "abcdef0123456789abcdef0123456789abcdef01",
      builtAt: "2026-07-10T12:34:56.000Z",
      buildId: "2026.7.10-abcdef012345-2026-07-10T12-34-56.000Z",
    });
  });

  it("uses null when Git metadata is unavailable", () => {
    expect(resolve({ env: {}, execFileSync: unavailableGit }).commit).toBeNull();
  });

  it("shares explicit release artifact identity with the Control UI", () => {
    expect(
      resolve({
        env: {
          GIT_COMMIT: "a".repeat(40),
          OPENCLAW_BUILD_TIMESTAMP: "2026-07-10T01:02:03.000Z",
          OPENCLAW_CONTROL_UI_RELEASE_BUILD: "1",
        },
      }).buildId,
    ).toBe("2026.7.10-release-aaaaaaaaaaaa-2026-07-10T01-02-03.000Z");
  });

  it("preserves GIT_COMMIT then GIT_SHA explicit input precedence", () => {
    const fallbackSha = "1234567890abcdef1234567890abcdef12345678";

    expect(resolve({ env: { GIT_SHA: fallbackSha } }).commit).toBe(fallbackSha);
    expect(() => resolve({ env: { GIT_COMMIT: "bad", GIT_SHA: fallbackSha } })).toThrow(
      "GIT_COMMIT must be a full 40-character Git commit SHA.",
    );
  });

  it("uses checked-out Git instead of unverified GitHub workflow context", () => {
    const checkedOutCommit = "b".repeat(40);
    const execFileSync = vi.fn(() => checkedOutCommit);
    const env = { GITHUB_SHA: "a".repeat(40) };
    expect(resolve({ env, execFileSync }).commit).toBe(checkedOutCommit);
    expect(execFileSync).toHaveBeenCalledOnce();
    expect(resolve({ env, execFileSync: unavailableGit }).commit).toBe(env.GITHUB_SHA);
    expect(() => resolve({ env: { GITHUB_SHA: "bad" }, execFileSync: unavailableGit })).toThrow(
      "GITHUB_SHA must be a full 40-character Git commit SHA.",
    );
  });

  it.each(["abc1234", "g".repeat(40)])("rejects malformed explicit commit %s", (commit) => {
    expect(() => normalizeBuildCommit(commit)).toThrow(
      "GIT_COMMIT must be a full 40-character Git commit SHA.",
    );
  });

  it("normalizes valid UTC timestamps and rejects offsets or impossible dates", () => {
    expect(normalizeBuildTimestamp("2026-07-10T12:34:56.7Z")).toBe("2026-07-10T12:34:56.700Z");
    expect(() => normalizeBuildTimestamp("2026-07-10T12:34:56+00:00")).toThrow(
      "OPENCLAW_BUILD_TIMESTAMP must be an ISO-8601 UTC timestamp ending in Z.",
    );
    expect(() => normalizeBuildTimestamp("2026-02-30T12:34:56Z")).toThrow(
      "OPENCLAW_BUILD_TIMESTAMP must be a valid ISO-8601 UTC timestamp.",
    );
  });
});

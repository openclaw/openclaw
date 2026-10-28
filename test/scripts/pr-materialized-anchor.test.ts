import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, symlinkSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sweepMaterializedAnchors } from "../../scripts/pr-lib/materialized-anchor.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
const describePosix = process.platform === "win32" ? describe.skip : describe;

function reapedPid() {
  const result = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], {
    encoding: "utf8",
  });
  expect(result.status, result.stderr).toBe(0);
  return Number(result.stdout);
}

function directory(root: string, name: string) {
  const path = join(root, name);
  mkdirSync(path, { mode: 0o700 });
  utimesSync(path, 0, 0);
  return path;
}

// Advancing the clock ages ctime as well as the utimes-controlled mtime, without
// weakening production's rule that either recent timestamp retains an anchor.
function ageFixtures() {
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + 25 * 60 * 60 * 1000);
}

describePosix("materialized PR anchor sweep", () => {
  it("removes only old dead creators and legacy directories, excluding its own anchor", () => {
    const root = tempDirs.make("pr-anchor-sweep-");
    const dead = reapedPid();
    const stale = directory(root, `openclaw-pr-anchor.${dead}.stale`);
    const legacy = directory(root, "openclaw-pr-anchor.legacy");
    const live = directory(root, `openclaw-pr-anchor.${process.pid}.live`);
    const young = directory(root, `openclaw-pr-anchor.${dead}.young`);
    const recentMetadata = directory(root, `openclaw-pr-anchor.${dead}.ctime`);
    const wrongMode = directory(root, `openclaw-pr-anchor.${dead}.mode`);
    chmodSync(wrongMode, 0o755);
    const unrelated = directory(root, "other-anchor.stale");
    const own = directory(root, `openclaw-pr-anchor.${dead}.own`);
    const ownIdentity = { path: own, ...lstatSync(own, { bigint: true }) };
    const alias = join(root, `openclaw-pr-anchor.${dead}.alias`);
    symlinkSync(unrelated, alias);
    const warning = vi.spyOn(console, "error").mockImplementation(() => {});
    ageFixtures();
    const now = Date.now() / 1000;
    utimesSync(young, now, now);
    // Simulate an old mtime with a recent metadata change.
    vi.spyOn(Date, "now").mockReturnValue(lstatSync(recentMetadata).ctimeMs + 60 * 60 * 1000);
    vi.stubEnv("TMPDIR", root);
    sweepMaterializedAnchors(ownIdentity);
    expect(existsSync(recentMetadata)).toBe(true);
    ageFixtures();
    sweepMaterializedAnchors(ownIdentity);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(legacy)).toBe(false);
    for (const path of [live, young, wrongMode, unrelated, own, alias]) {
      expect(existsSync(path), path).toBe(true);
    }
    expect(warning).toHaveBeenCalledTimes(1);
    expect(warning).toHaveBeenCalledWith("Removed 3 stale materialized PR wrapper directories.");
  });

  it("removes at most four stale anchors per supervisor startup", () => {
    const root = tempDirs.make("pr-anchor-sweep-limit-");
    const dead = reapedPid();
    const anchors = Array.from({ length: 6 }, (_, index) =>
      directory(root, `openclaw-pr-anchor.${dead}.anchor${index}`),
    );
    ageFixtures();
    vi.stubEnv("TMPDIR", root);
    const report = vi.spyOn(console, "error").mockImplementation(() => {});
    sweepMaterializedAnchors();
    expect(anchors.filter((path) => existsSync(path))).toHaveLength(2);
    expect(report).toHaveBeenCalledExactlyOnceWith(
      "Removed 4 stale materialized PR wrapper directories.",
    );
  });
});

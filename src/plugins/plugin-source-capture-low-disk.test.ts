import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createPluginSourceCaptureRoot } from "./plugin-source-capture-directory.js";
import {
  assertPluginSourceCaptureDiskHeadroom,
  PluginSourceCaptureLowDiskError,
  resolvePluginSourceCaptureMinFreeBytes,
} from "./plugin-source-capture-low-disk.js";

const temp = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function statfsResult(freeBytes: number): fs.StatsFs {
  const blockCount = Math.max(1, Math.ceil(freeBytes / 4096));
  return {
    type: 0,
    bsize: 4096,
    blocks: blockCount,
    bfree: blockCount,
    bavail: blockCount,
    files: 1_000_000,
    ffree: 1_000_000,
  } as fs.StatsFs;
}

it("resolves the floor from the environment and rejects malformed overrides", () => {
  const warnSpy = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
  vi.stubEnv("OPENCLAW_PLUGIN_CAPTURE_MIN_FREE_BYTES", "1048576");
  expect(resolvePluginSourceCaptureMinFreeBytes()).toBe(1_048_576);
  // A numeric prefix ("0oops" -> parseInt 0) must never disable the guard.
  vi.stubEnv("OPENCLAW_PLUGIN_CAPTURE_MIN_FREE_BYTES", "0oops");
  expect(resolvePluginSourceCaptureMinFreeBytes()).toBe(512 * 1024 * 1024);
  vi.stubEnv("OPENCLAW_PLUGIN_CAPTURE_MIN_FREE_BYTES", "not-a-number");
  expect(resolvePluginSourceCaptureMinFreeBytes()).toBe(512 * 1024 * 1024);
  vi.stubEnv("OPENCLAW_PLUGIN_CAPTURE_MIN_FREE_BYTES", "-5");
  expect(resolvePluginSourceCaptureMinFreeBytes()).toBe(512 * 1024 * 1024);
  expect(warnSpy).toHaveBeenCalled();
});

it("refuses to stage captures when the target volume is below the free-space floor", () => {
  const stateDir = temp.make("plugin-capture-low-disk-");
  vi.spyOn(process, "emitWarning").mockImplementation(() => {});
  const statfsSpy = vi
    .spyOn(fs, "statfsSync")
    .mockImplementation((() => statfsResult(4096)) as unknown as typeof fs.statfsSync);
  expect(() => createPluginSourceCaptureRoot(stateDir, "openclaw-plugin-build-")).toThrowError(
    PluginSourceCaptureLowDiskError,
  );
  expect(statfsSpy).toHaveBeenCalled();
  const capturesDir = path.join(stateDir, "tmp", "plugin-captures");
  const entries = fs.existsSync(capturesDir) ? fs.readdirSync(capturesDir) : [];
  expect(entries).toEqual([]);
});

it("skips the guard without touching the volume when the floor is disabled", () => {
  const stateDir = temp.make("plugin-capture-no-floor-");
  vi.stubEnv("OPENCLAW_PLUGIN_CAPTURE_MIN_FREE_BYTES", "0");
  const statfsSpy = vi.spyOn(fs, "statfsSync");
  expect(() =>
    assertPluginSourceCaptureDiskHeadroom(stateDir, resolvePluginSourceCaptureMinFreeBytes()),
  ).not.toThrow();
  expect(statfsSpy).not.toHaveBeenCalled();
});

it("still stages captures when the volume reports headroom", async () => {
  const stateDir = temp.make("plugin-capture-headroom-");
  vi.spyOn(fs, "statfsSync").mockImplementation((() =>
    statfsResult(8 * 1024 * 1024 * 1024)) as unknown as typeof fs.statfsSync);
  const capture = createPluginSourceCaptureRoot(stateDir, "openclaw-plugin-build-");
  try {
    expect(fs.existsSync(capture.directory)).toBe(true);
  } finally {
    await capture.release();
  }
});

it("refuses captures through the real statfs when the floor cannot be met (regression: ENOENT fail-open)", () => {
  const stateDir = temp.make("plugin-capture-real-statfs-");
  // The capture target does not exist yet: statfs must be probed at the nearest
  // existing ancestor, or the guard silently passes exactly when it is needed.
  const stats = fs.statfsSync(stateDir);
  const absurdFloor = Math.ceil(stats.bavail * stats.bsize) * 1000 + 1;
  vi.stubEnv("OPENCLAW_PLUGIN_CAPTURE_MIN_FREE_BYTES", String(absurdFloor));
  expect(() => createPluginSourceCaptureRoot(stateDir, "openclaw-plugin-build-")).toThrowError(
    PluginSourceCaptureLowDiskError,
  );
  const capturesDir = path.join(stateDir, "tmp", "plugin-captures");
  const entries = fs.existsSync(capturesDir) ? fs.readdirSync(capturesDir) : [];
  expect(entries).toEqual([]);
});

it("falls back to the temporary placement when the state volume is low but tmp has headroom", async () => {
  const stateDir = temp.make("plugin-capture-fallback-");
  const tmpRoot = temp.make("plugin-capture-fallback-tmp-");
  vi.stubEnv("TMPDIR", tmpRoot);
  vi.spyOn(process, "emitWarning").mockImplementation(() => {});
  vi.spyOn(fs, "statfsSync").mockImplementation(((target: fs.PathLike) =>
    statfsResult(
      String(target).startsWith(tmpRoot) ? 8 * 1024 * 1024 * 1024 : 4096,
    )) as unknown as typeof fs.statfsSync);
  const capture = createPluginSourceCaptureRoot(stateDir, "openclaw-plugin-build-");
  try {
    expect(capture.directory.startsWith(tmpRoot)).toBe(true);
  } finally {
    await capture.release();
  }
});

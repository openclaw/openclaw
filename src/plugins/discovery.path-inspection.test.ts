import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { discoverConfiguredPluginLoadPaths } from "./discovery.js";
import { pluginCacheStatSync } from "./plugin-cache-files.js";
import { resetPluginCache } from "./plugin-cache.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.restoreAllMocks();
  resetPluginCache();
});

it.each([
  { code: "ENOENT", reason: "configured-plugin-path-unavailable" },
  { code: "ENOTDIR", reason: "configured-plugin-path-unavailable" },
  { code: "not-found", reason: "configured-plugin-path-unavailable" },
  { code: "EACCES", reason: "configured-plugin-path-inspection-failed" },
  { code: "EPERM", reason: "configured-plugin-path-inspection-failed" },
  { code: "EIO", reason: "configured-plugin-path-inspection-failed" },
  { code: "ELOOP", reason: "configured-plugin-path-inspection-failed" },
  { code: undefined, reason: "configured-plugin-path-inspection-failed" },
])("classifies directory inspection by code $code, not message text", ({ code, reason }) => {
  const root = tempDirs.make("openclaw-directory-failure-");
  const readDirectory = fs.readdirSync;
  vi.spyOn(fs, "readdirSync").mockImplementation((target, options) => {
    if (target === root) {
      throw Object.assign(new Error("ENOENT: misleading message"), { code });
    }
    return readDirectory.call(fs, target, options);
  });
  const result = discoverConfiguredPluginLoadPaths({ loadPaths: [root] });
  expect(result.candidates).toEqual([]);
  expect(result.diagnostics).toEqual([
    expect.objectContaining({ code: reason, configDisposition: "preserve" }),
  ]);
  if (reason === "configured-plugin-path-inspection-failed") {
    expect(result.diagnostics[0]).toMatchObject({
      errorCode: code ?? "UNKNOWN",
      message: expect.stringContaining("misleading message"),
    });
  }
});

it.skipIf(process.platform === "win32")("retains a cached stat failure's ELOOP diagnosis", () => {
  const root = tempDirs.make("openclaw-stat-failure-");
  const loop = path.join(root, "loop");
  fs.symlinkSync(loop, loop);
  expect(pluginCacheStatSync(loop)).toBeNull();
  expect(discoverConfiguredPluginLoadPaths({ loadPaths: [loop] }).diagnostics).toEqual([
    expect.objectContaining({
      code: "configured-plugin-path-inspection-failed",
      errorCode: "ELOOP",
      configDisposition: "preserve",
    }),
  ]);
});

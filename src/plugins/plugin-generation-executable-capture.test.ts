import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createPluginGenerationExecutableCapture } from "./plugin-generation-executable-capture.js";
import { makeTrackedTempDir, cleanupTrackedTempDirs } from "./test-helpers/fs-fixtures.js";

describe("plugin generation executable capture", () => {
  it("canonicalizes symlinked files and ignores directory targets", () => {
    const tempDirs: string[] = [];
    const root = makeTrackedTempDir("openclaw-executable-capture", tempDirs);
    try {
      fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "fixture" }));
      const executable = path.join(root, "bin.cjs");
      fs.writeFileSync(executable, "module.exports = true;\n");
      const symlink = path.join(root, "bin-link.cjs");
      fs.symlinkSync("bin.cjs", symlink);
      const copyPackage = vi.fn(() => root);
      const capture = createPluginGenerationExecutableCapture({
        execute: (run) => run(),
        packages: new Map(),
        copyPackage,
      });
      const realRoot = fs.realpathSync(root);
      const realExecutable = fs.realpathSync(executable);

      expect(capture.captureExecutableFile(symlink)).toBe(realExecutable);
      expect(copyPackage).toHaveBeenCalledWith(realRoot, realExecutable, false, true);
      expect(capture.captureExecutableFile(root)).toBeUndefined();
      expect(copyPackage).toHaveBeenCalledOnce();
    } finally {
      cleanupTrackedTempDirs(tempDirs);
    }
  });
});

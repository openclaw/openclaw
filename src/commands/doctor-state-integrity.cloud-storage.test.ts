import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { detectMacCloudSyncedStateDir } from "./doctor-state-integrity.js";

describe("detectMacCloudSyncedStateDir", () => {
  const home = "/Users/tester";

  it("detects state dir under iCloud Drive", () => {
    const stateDir = path.join(
      home,
      "Library",
      "Mobile Documents",
      "com~apple~CloudDocs",
      "Mullusi",
      ".mullusi",
    );

    const result = detectMacCloudSyncedStateDir(stateDir, {
      platform: "darwin",
      homedir: home,
    });

    expect(result).toEqual({
      path: path.resolve(stateDir),
      storage: "iCloud Drive",
    });
  });

  it("detects state dir under Library/CloudStorage", () => {
    const stateDir = path.join(home, "Library", "CloudStorage", "Dropbox", "Mullusi", ".mullusi");

    const result = detectMacCloudSyncedStateDir(stateDir, {
      platform: "darwin",
      homedir: home,
    });

    expect(result).toEqual({
      path: path.resolve(stateDir),
      storage: "CloudStorage provider",
    });
  });

  it("detects cloud-synced target when state dir resolves via symlink", () => {
    const symlinkPath = "/tmp/mullusi-state";
    const resolvedCloudPath = path.join(
      home,
      "Library",
      "CloudStorage",
      "OneDrive-Personal",
      "Mullusi",
      ".mullusi",
    );

    const result = detectMacCloudSyncedStateDir(symlinkPath, {
      platform: "darwin",
      homedir: home,
      resolveRealPath: () => resolvedCloudPath,
    });

    expect(result).toEqual({
      path: path.resolve(resolvedCloudPath),
      storage: "CloudStorage provider",
    });
  });

  it("ignores cloud-synced symlink prefix when resolved target is local", () => {
    const symlinkPath = path.join(
      home,
      "Library",
      "CloudStorage",
      "OneDrive-Personal",
      "Mullusi",
      ".mullusi",
    );
    const resolvedLocalPath = path.join(home, ".mullusi");

    const result = detectMacCloudSyncedStateDir(symlinkPath, {
      platform: "darwin",
      homedir: home,
      resolveRealPath: () => resolvedLocalPath,
    });

    expect(result).toBeNull();
  });

  it("anchors cloud detection to OS homedir when MULLUSI_HOME is overridden", () => {
    const stateDir = path.join(home, "Library", "CloudStorage", "iCloud Drive", ".mullusi");
    const originalMullusiHome = process.env.MULLUSI_HOME;
    process.env.MULLUSI_HOME = "/tmp/mullusi-home-override";
    const homedirSpy = vi.spyOn(os, "homedir").mockReturnValue(home);
    try {
      const result = detectMacCloudSyncedStateDir(stateDir, {
        platform: "darwin",
      });

      expect(result).toEqual({
        path: path.resolve(stateDir),
        storage: "CloudStorage provider",
      });
    } finally {
      homedirSpy.mockRestore();
      if (originalMullusiHome === undefined) {
        delete process.env.MULLUSI_HOME;
      } else {
        process.env.MULLUSI_HOME = originalMullusiHome;
      }
    }
  });

  it("returns null outside darwin", () => {
    const stateDir = path.join(
      home,
      "Library",
      "Mobile Documents",
      "com~apple~CloudDocs",
      "Mullusi",
      ".mullusi",
    );

    const result = detectMacCloudSyncedStateDir(stateDir, {
      platform: "linux",
      homedir: home,
    });

    expect(result).toBeNull();
  });
});

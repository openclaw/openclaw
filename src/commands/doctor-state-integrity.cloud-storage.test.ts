import path from "node:path";
import { describe, expect, it } from "vitest";
import { detectMacCloudSyncedStateDir } from "./doctor-state-integrity.js";

describe("detectMacCloudSyncedStateDir", () => {
  const home = "/Users/tester";

  it("detects state dir under iCloud Drive", () => {
    const stateDir = path.join(
      home,
      "Library",
      "Mobile Documents",
      "com~apple~CloudDocs",
      "OpenClaw",
      ".openclaw",
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
    const stateDir = path.join(home, "Library", "CloudStorage", "Dropbox", "OpenClaw", ".openclaw");

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
    const symlinkPath = "/tmp/openclaw-state";
    const resolvedCloudPath = path.join(
      home,
      "Library",
      "CloudStorage",
      "OneDrive-Personal",
      "OpenClaw",
      ".openclaw",
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

  it("returns null outside darwin", () => {
    const stateDir = path.join(
      home,
      "Library",
      "Mobile Documents",
      "com~apple~CloudDocs",
      "OpenClaw",
      ".openclaw",
    );

    const result = detectMacCloudSyncedStateDir(stateDir, {
      platform: "linux",
      homedir: home,
    });

    expect(result).toBeNull();
  });
});

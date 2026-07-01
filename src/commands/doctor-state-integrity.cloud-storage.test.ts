// Doctor state integrity cloud-storage tests cover macOS cloud-synced state directory detection.
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  detectMacCloudSyncedStateDir,
  detectWindowsCloudSyncedStateDir,
  stateIntegrityIssueToHealthFinding,
  stateIntegrityIssueToRepairEffect,
} from "./doctor-state-integrity.js";

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

  it("ignores cloud-synced symlink prefix when resolved target is local", () => {
    const symlinkPath = path.join(
      home,
      "Library",
      "CloudStorage",
      "OneDrive-Personal",
      "OpenClaw",
      ".openclaw",
    );
    const resolvedLocalPath = path.join(home, ".openclaw");

    const result = detectMacCloudSyncedStateDir(symlinkPath, {
      platform: "darwin",
      homedir: home,
      resolveRealPath: () => resolvedLocalPath,
    });

    expect(result).toBeNull();
  });

  it("anchors cloud detection to OS homedir when OPENCLAW_HOME is overridden", () => {
    const stateDir = path.join(home, "Library", "CloudStorage", "iCloud Drive", ".openclaw");
    const originalOpenClawHome = process.env.OPENCLAW_HOME;
    process.env.OPENCLAW_HOME = "/tmp/openclaw-home-override";
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
      if (originalOpenClawHome === undefined) {
        delete process.env.OPENCLAW_HOME;
      } else {
        process.env.OPENCLAW_HOME = originalOpenClawHome;
      }
    }
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

describe("detectWindowsCloudSyncedStateDir", () => {
  const winPath = path.win32;
  const home = "C:\\Users\\tester";

  it("detects state dir under OneDrive env root", () => {
    const oneDriveRoot = winPath.join(home, "OneDrive - Example");
    const stateDir = winPath.join(oneDriveRoot, "Desktop", "OpenClaw", ".openclaw");

    const result = detectWindowsCloudSyncedStateDir(stateDir, {
      platform: "win32",
      homedir: home,
      env: { OneDriveCommercial: oneDriveRoot },
    });

    expect(result).toEqual({
      path: winPath.resolve(stateDir),
      storage: "OneDrive",
    });
  });

  it("detects common Windows cloud storage folders under the user profile", () => {
    const stateDir = winPath.join(home, "Dropbox", "OpenClaw", ".openclaw");

    const result = detectWindowsCloudSyncedStateDir(stateDir, {
      platform: "win32",
      homedir: home,
      env: {},
    });

    expect(result).toEqual({
      path: winPath.resolve(stateDir),
      storage: "Dropbox",
    });
  });

  it("detects personal and organization OneDrive folders under the user profile", () => {
    for (const folderName of ["OneDrive", "OneDrive - Contoso"]) {
      const stateDir = winPath.join(home, folderName, "OpenClaw", ".openclaw");

      const result = detectWindowsCloudSyncedStateDir(stateDir, {
        platform: "win32",
        homedir: home,
        env: {},
      });

      expect(result).toEqual({
        path: winPath.resolve(stateDir),
        storage: "OneDrive",
      });
    }
  });

  it("detects cloud-synced target when state dir resolves via reparse point", () => {
    const junctionPath = winPath.join(home, ".openclaw");
    const resolvedCloudPath = winPath.join(home, "OneDrive", "OpenClaw", ".openclaw");

    const result = detectWindowsCloudSyncedStateDir(junctionPath, {
      platform: "win32",
      homedir: home,
      env: {},
      resolveRealPath: () => resolvedCloudPath,
    });

    expect(result).toEqual({
      path: winPath.resolve(resolvedCloudPath),
      storage: "OneDrive",
    });
  });

  it("ignores cloud-synced prefix when resolved target is local", () => {
    const junctionPath = winPath.join(home, "OneDrive", "OpenClaw", ".openclaw");
    const resolvedLocalPath = winPath.join(home, ".openclaw");

    const result = detectWindowsCloudSyncedStateDir(junctionPath, {
      platform: "win32",
      homedir: home,
      env: {},
      resolveRealPath: () => resolvedLocalPath,
    });

    expect(result).toBeNull();
  });

  it("returns null outside Windows", () => {
    const stateDir = winPath.join(home, "OneDrive", "OpenClaw", ".openclaw");

    const result = detectWindowsCloudSyncedStateDir(stateDir, {
      platform: "linux",
      homedir: home,
      env: {},
    });

    expect(result).toBeNull();
  });

  it("maps Windows cloud state dir findings to warning and dry-run effect", () => {
    const issue = {
      kind: "windows-cloud-state-dir" as const,
      path: winPath.join(home, "OneDrive", "OpenClaw", ".openclaw"),
      storage: "OneDrive",
    };

    expect(stateIntegrityIssueToHealthFinding(issue)).toMatchObject({
      checkId: "core/doctor/state-integrity",
      severity: "warning",
      path: issue.path,
    });
    expect(stateIntegrityIssueToRepairEffect(issue)).toEqual({
      kind: "state",
      action: "would-recommend-moving-state-dir",
      target: issue.path,
      dryRunSafe: true,
    });
  });
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as boundaryPath from "../infra/boundary-path.js";
import {
  detectMacCloudSyncedStateDir,
  detectWindowsCloudSyncedStateDir,
  formatWindowsCloudSyncedStateDirWarning,
} from "./doctor-state-integrity.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("cloud-synced state directories", () => {
  it("anchors iCloud detection to the OS home despite OPENCLAW_HOME", () => {
    const home = path.resolve("/Users/tester");
    const stateDir = path.join(home, "Library/Mobile Documents/com~apple~CloudDocs/.openclaw");
    vi.stubEnv("OPENCLAW_HOME", "/tmp/openclaw-home-override");
    vi.spyOn(os, "homedir").mockReturnValue(home);
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    expect(detectMacCloudSyncedStateDir(stateDir)).toEqual({
      path: stateDir,
      storage: "iCloud Drive",
    });
  });

  it.each([false, true])(
    "resolves a missing macOS state leaf through its ancestor (local symlink=%s)",
    (local) => {
      const sandbox = fs.realpathSync(tempDirs.make("openclaw-cloud-storage-"));
      const home = path.join(sandbox, "home");
      const cloudRoot = path.join(home, "Library", "CloudStorage");
      const syncedDir = path.join(cloudRoot, "OneDrive-Personal");
      fs.mkdirSync(cloudRoot, { recursive: true });
      if (local) {
        const target = path.join(sandbox, "local-openclaw");
        fs.mkdirSync(target);
        fs.symlinkSync(target, syncedDir, process.platform === "win32" ? "junction" : "dir");
      } else {
        fs.mkdirSync(syncedDir);
      }
      const stateDir = path.join(syncedDir, "OpenClaw", ".openclaw");
      expect(fs.existsSync(stateDir)).toBe(false);
      vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
      vi.spyOn(os, "homedir").mockReturnValue(home);
      expect(detectMacCloudSyncedStateDir(stateDir)).toEqual(
        local ? null : { path: stateDir, storage: "CloudStorage provider" },
      );
    },
  );

  it("detects a missing OneDrive business leaf case-insensitively and explains service relocation", () => {
    const personal = path.resolve("/Users/tester/OneDrive");
    const business = path.resolve("/Users/tester/OneDrive - Contoso");
    const root = path.join(business, "OpenClaw").toUpperCase();
    const stateDir = path.join(root, ".openclaw");
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    vi.spyOn(boundaryPath, "safeRealpathSync").mockImplementation((target) =>
      target === root ? root : null,
    );
    const result = detectWindowsCloudSyncedStateDir(
      stateDir,
      Object.freeze({
        OneDrive: personal,
        onedriveconsumer: personal,
        oNeDrIvEcOmMeRcIaL: business,
      }),
    );
    expect(result).toEqual({ path: stateDir, storage: "OneDrive for Business" });
    if (!result) {
      throw new Error("expected OneDrive warning");
    }
    const warning = formatWindowsCloudSyncedStateDirWarning(stateDir, result);
    expect(warning).toContain("Windows cloud-synced storage");
    expect(warning).toContain("OneDrive for Business");
    expect(warning).toContain("stop the Gateway");
    expect(warning).toContain("for the Gateway service");
    expect(warning).toContain("re-run doctor");
    expect(warning).not.toMatch(/(?:^|\s)OPENCLAW_STATE_DIR=\S+\s+\S*openclaw\b/m);
    expect(warning).not.toContain("$env:OPENCLAW_STATE_DIR");
    expect(warning).not.toContain('set "OPENCLAW_STATE_DIR=');
  });

  it("follows a junction out of OneDrive when the state leaf is absent", () => {
    const root = path.resolve("/Users/tester/OneDrive/OpenClaw");
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    vi.spyOn(boundaryPath, "safeRealpathSync").mockImplementation((target) =>
      target === root ? path.resolve("/local-openclaw") : null,
    );
    expect(
      detectWindowsCloudSyncedStateDir(path.join(root, ".openclaw"), {
        OneDrive: path.dirname(root),
      }),
    ).toBeNull();
  });

  it("does not infer a sync root from a OneDrive-named folder without the client's environment", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    expect(
      detectWindowsCloudSyncedStateDir(path.resolve("/Users/tester/OneDrive/.openclaw"), {}),
    ).toBeNull();
  });
});

import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  resolvePluginNpmGenerationProjectDir,
  resolvePluginNpmProjectDir,
} from "./install-paths.js";
import {
  RETAINED_MANAGED_NPM_DOCTOR_REPAIR_REASON,
  RETAINED_MANAGED_NPM_DOCTOR_MISSING_DEPENDENCIES_REASON,
  RETAINED_MANAGED_NPM_GENERATION_UPDATE_REASON,
  RETAINED_MANAGED_NPM_INFERENCE_ACTIVATION_REASON,
  RETAINED_MANAGED_NPM_KEEP_FILES_REASON,
  RETAINED_MANAGED_NPM_PLUGIN_SOURCE_CHANGE_REASON,
} from "./managed-npm-retention-contract.js";
import {
  clearRetainedManagedNpmInstallMarker,
  cleanupRetainedManagedNpmInstallGenerations,
  hasRetainedManagedNpmInstallMarker,
  markRetainedManagedNpmInstall,
  resolveRetainedManagedNpmInstallMarkerPath,
} from "./managed-npm-retention.js";

const retentionTempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("managed npm retention", () => {
  it.each(["stat", "mkdir"] as const)(
    "fences marker creation after authority is revoked during %s",
    async (preparation) => {
      const stateDir = retentionTempDirs.make("openclaw-retention-fence-");
      const packageDir = path.join(stateDir, "npm", "node_modules", "retained-plugin");
      fs.mkdirSync(packageDir, { recursive: true });
      const markerPath = resolveRetainedManagedNpmInstallMarkerPath(packageDir);
      const markerDir = path.dirname(markerPath);
      const previous = '{"reason":"existing-retention"}\n';
      if (preparation === "mkdir") {
        fs.mkdirSync(markerDir);
        fs.writeFileSync(markerPath, previous);
      }
      let current = true;
      const failure = new Error("update authority revoked");
      const mkdir = fs.promises.mkdir.bind(fs.promises);
      const mkdirSpy = vi
        .spyOn(fs.promises, "mkdir")
        .mockImplementation(async (target, options) => {
          const result = await mkdir(target, options);
          if (preparation === "mkdir") {
            current = false;
          }
          return result;
        });
      try {
        const operation = markRetainedManagedNpmInstall({
          packageDir,
          pluginId: "retained-plugin",
          reason: "replaced-by-update",
          assertCurrent: () => {
            if (!current) {
              throw failure;
            }
          },
        });
        if (preparation === "stat") {
          current = false;
        }
        await expect(operation).rejects.toBe(failure);
        expect(fs.existsSync(packageDir)).toBe(true);
        if (preparation === "mkdir") {
          expect(fs.readFileSync(markerPath, "utf8")).toBe(previous);
        } else {
          expect(fs.existsSync(markerDir)).toBe(false);
        }
      } finally {
        mkdirSpy.mockRestore();
      }
    },
  );

  it("preserves a marker when clearing loses authority and still permits independent callers", async () => {
    const stateDir = retentionTempDirs.make("openclaw-retention-clear-fence-");
    const packageDir = path.join(stateDir, "npm", "node_modules", "retained-plugin");
    fs.mkdirSync(packageDir, { recursive: true });
    await markRetainedManagedNpmInstall({
      packageDir,
      pluginId: "retained-plugin",
      reason: "retained-package",
    });
    const markerPath = resolveRetainedManagedNpmInstallMarkerPath(packageDir);
    const before = fs.readFileSync(markerPath, "utf8");
    const failure = Object.assign(new Error("update authority revoked"), { code: "ENOENT" });
    let checks = 0;

    await expect(
      clearRetainedManagedNpmInstallMarker(packageDir, () => {
        if (checks++ === 0) {
          throw failure;
        }
      }),
    ).rejects.toBe(failure);
    expect(fs.readFileSync(markerPath, "utf8")).toBe(before);
    await expect(clearRetainedManagedNpmInstallMarker(packageDir)).resolves.toBe(true);
    expect(fs.existsSync(markerPath)).toBe(false);
    expect(fs.existsSync(packageDir)).toBe(true);
  });

  it("does not swallow a one-shot refusal or remove the marker directory after awaited removal", async () => {
    const stateDir = retentionTempDirs.make("openclaw-retention-clear-fence-");
    const packageDir = path.join(stateDir, "npm", "node_modules", "retained-plugin");
    fs.mkdirSync(packageDir, { recursive: true });
    await markRetainedManagedNpmInstall({
      packageDir,
      pluginId: "retained-plugin",
      reason: "retained-package",
    });
    const markerPath = resolveRetainedManagedNpmInstallMarkerPath(packageDir);
    let current = true;
    const failure = new Error("update authority revoked after removal");
    const rm = fs.promises.rm.bind(fs.promises);
    const rmSpy = vi.spyOn(fs.promises, "rm").mockImplementation(async (target, options) => {
      await rm(target, options);
      current = false;
    });
    try {
      await expect(
        clearRetainedManagedNpmInstallMarker(packageDir, () => {
          if (!current) {
            current = true;
            throw failure;
          }
        }),
      ).rejects.toBe(failure);
      expect(fs.existsSync(markerPath)).toBe(false);
      expect(fs.existsSync(path.dirname(markerPath))).toBe(true);
      expect(fs.existsSync(packageDir)).toBe(true);
    } finally {
      rmSpy.mockRestore();
    }
  });

  it.each(["ordinary", "generation"] as const)(
    "cleans a preexisting v1 retired %s project while preserving the active install root",
    async (layout) => {
      const stateDir = retentionTempDirs.make("openclaw-retention-");
      const npmDir = path.join(stateDir, "npm");
      const packageName = "@openclaw/codex";
      const oldProjectRoot =
        layout === "ordinary"
          ? resolvePluginNpmProjectDir({ npmDir, packageName })
          : resolvePluginNpmGenerationProjectDir({
              npmDir,
              packageName,
              generationKey: "codex-v1",
            });
      const activeProjectRoot = resolvePluginNpmGenerationProjectDir({
        npmDir,
        packageName,
        generationKey: "codex-v2",
      });
      const oldPackageDir = path.join(oldProjectRoot, "node_modules", "@openclaw", "codex");
      const activePackageDir = path.join(activeProjectRoot, "node_modules", "@openclaw", "codex");
      fs.mkdirSync(oldPackageDir, { recursive: true });
      fs.mkdirSync(activePackageDir, { recursive: true });
      const markerPath = resolveRetainedManagedNpmInstallMarkerPath(oldPackageDir);
      fs.mkdirSync(path.dirname(markerPath), { recursive: true });
      fs.writeFileSync(
        markerPath,
        `${JSON.stringify({
          version: 1,
          pluginId: "codex",
          retainedAt: "2026-08-01T00:00:00.000Z",
          reason: RETAINED_MANAGED_NPM_GENERATION_UPDATE_REASON,
        })}\n`,
        "utf8",
      );

      await expect(
        cleanupRetainedManagedNpmInstallGenerations({
          npmDir,
          activeInstallPaths: [activePackageDir],
        }),
      ).resolves.toBe(1);
      expect(fs.existsSync(oldProjectRoot)).toBe(false);
      expect(fs.existsSync(activeProjectRoot)).toBe(true);
      expect(hasRetainedManagedNpmInstallMarker(activePackageDir)).toBe(false);
    },
  );

  it("cleans retained packages from the legacy shared npm root", async () => {
    const stateDir = retentionTempDirs.make("openclaw-retention-");
    const npmDir = path.join(stateDir, "npm");
    const packageDir = path.join(npmDir, "node_modules", "@openclaw", "codex");
    fs.mkdirSync(packageDir, { recursive: true });
    await markRetainedManagedNpmInstall({
      packageDir,
      pluginId: "codex",
      reason: RETAINED_MANAGED_NPM_DOCTOR_REPAIR_REASON,
    });

    await expect(
      cleanupRetainedManagedNpmInstallGenerations({
        npmDir,
      }),
    ).resolves.toBe(1);
    expect(fs.existsSync(packageDir)).toBe(false);
    expect(hasRetainedManagedNpmInstallMarker(packageDir)).toBe(false);
  });

  it("preserves a noncanonical project root even when it has a retained marker", async () => {
    const stateDir = retentionTempDirs.make("openclaw-retention-noncanonical-");
    const npmDir = path.join(stateDir, "npm");
    const projectRoot = path.join(npmDir, "projects", "noncanonical-sibling");
    const packageDir = path.join(projectRoot, "node_modules", "@openclaw", "codex");
    const siblingFile = path.join(projectRoot, "must-remain.txt");
    fs.mkdirSync(packageDir, { recursive: true });
    fs.writeFileSync(siblingFile, "preserve me", "utf8");
    await markRetainedManagedNpmInstall({
      packageDir,
      pluginId: "codex",
      reason: RETAINED_MANAGED_NPM_GENERATION_UPDATE_REASON,
    });

    await expect(cleanupRetainedManagedNpmInstallGenerations({ npmDir })).resolves.toBe(0);
    expect(fs.readFileSync(siblingFile, "utf8")).toBe("preserve me");
  });

  it("does not follow a substituted managed projects directory", async () => {
    const stateDir = retentionTempDirs.make("openclaw-retention-symlink-");
    const npmDir = path.join(stateDir, "npm");
    const outsideProjectsDir = retentionTempDirs.make("openclaw-retention-outside-");
    fs.mkdirSync(npmDir, { recursive: true });
    fs.symlinkSync(outsideProjectsDir, path.join(npmDir, "projects"), "dir");
    const projectRoot = resolvePluginNpmProjectDir({
      npmDir,
      packageName: "@openclaw/codex",
    });
    const packageDir = path.join(projectRoot, "node_modules", "@openclaw", "codex");
    const sentinel = path.join(projectRoot, "must-remain.txt");
    fs.mkdirSync(packageDir, { recursive: true });
    fs.writeFileSync(sentinel, "preserve me", "utf8");
    await markRetainedManagedNpmInstall({
      packageDir,
      pluginId: "codex",
      reason: RETAINED_MANAGED_NPM_GENERATION_UPDATE_REASON,
    });

    await expect(cleanupRetainedManagedNpmInstallGenerations({ npmDir })).resolves.toBe(0);
    expect(fs.readFileSync(sentinel, "utf8")).toBe("preserve me");
  });

  it("ignores unmarked legacy packages without reporting an error", async () => {
    const stateDir = retentionTempDirs.make("openclaw-retention-");
    const npmDir = path.join(stateDir, "npm");
    const packageDir = path.join(npmDir, "node_modules", "@openclaw", "active-plugin");
    fs.mkdirSync(packageDir, { recursive: true });
    const onError = vi.fn();

    await expect(cleanupRetainedManagedNpmInstallGenerations({ npmDir, onError })).resolves.toBe(0);

    expect(fs.existsSync(packageDir)).toBe(true);
    expect(onError).not.toHaveBeenCalled();
  });

  it.each(["project", "legacy"] as const)(
    "preserves %s packages retained by an explicit keep-files uninstall",
    async (layout) => {
      const stateDir = retentionTempDirs.make("openclaw-retention-");
      const npmDir = path.join(stateDir, "npm");
      const projectRoot =
        layout === "legacy"
          ? npmDir
          : resolvePluginNpmGenerationProjectDir({
              npmDir,
              packageName: "@openclaw/kept-plugin",
              generationKey: "kept-plugin-v1",
            });
      const packageDir = path.join(projectRoot, "node_modules", "@openclaw", "kept-plugin");
      fs.mkdirSync(packageDir, { recursive: true });
      await markRetainedManagedNpmInstall({
        packageDir,
        pluginId: "kept-plugin",
        reason: RETAINED_MANAGED_NPM_KEEP_FILES_REASON,
      });

      await expect(cleanupRetainedManagedNpmInstallGenerations({ npmDir })).resolves.toBe(0);
      expect(fs.existsSync(packageDir)).toBe(true);
      expect(hasRetainedManagedNpmInstallMarker(packageDir)).toBe(true);
    },
  );

  it.each([
    { layout: "project" as const, markerState: "corrupt" as const },
    { layout: "legacy" as const, markerState: "corrupt" as const },
    { layout: "project" as const, markerState: "unknown" as const },
    { layout: "legacy" as const, markerState: "unknown" as const },
    { layout: "project" as const, markerState: "unsupported-version" as const },
    { layout: "legacy" as const, markerState: "unsupported-version" as const },
  ])(
    "preserves $layout package files for a $markerState marker",
    async ({ layout, markerState }) => {
      const stateDir = retentionTempDirs.make("openclaw-retention-");
      const npmDir = path.join(stateDir, "npm");
      const projectRoot =
        layout === "legacy"
          ? npmDir
          : resolvePluginNpmGenerationProjectDir({
              npmDir,
              packageName: "@openclaw/kept-plugin",
              generationKey: "kept-plugin-v1",
            });
      const packageDir = path.join(projectRoot, "node_modules", "@openclaw", "kept-plugin");
      fs.mkdirSync(packageDir, { recursive: true });
      await markRetainedManagedNpmInstall({
        packageDir,
        pluginId: "kept-plugin",
        reason:
          markerState === "unknown"
            ? "future-retention-policy"
            : RETAINED_MANAGED_NPM_GENERATION_UPDATE_REASON,
      });
      if (markerState === "corrupt") {
        fs.writeFileSync(resolveRetainedManagedNpmInstallMarkerPath(packageDir), "{", "utf8");
      } else if (markerState === "unsupported-version") {
        const markerPath = resolveRetainedManagedNpmInstallMarkerPath(packageDir);
        const marker = JSON.parse(fs.readFileSync(markerPath, "utf8")) as Record<string, unknown>;
        fs.writeFileSync(markerPath, `${JSON.stringify({ ...marker, version: 2 })}\n`, "utf8");
      }
      const onError = vi.fn();

      await expect(cleanupRetainedManagedNpmInstallGenerations({ npmDir, onError })).resolves.toBe(
        0,
      );

      expect(fs.existsSync(packageDir)).toBe(true);
      expect(hasRetainedManagedNpmInstallMarker(packageDir)).toBe(true);
      expect(onError).toHaveBeenCalledOnce();
      expect(onError).toHaveBeenCalledWith(
        expect.any(Error),
        layout === "legacy" ? packageDir : projectRoot,
      );
    },
  );

  // Root bypasses mode bits, so chmod cannot model an unreadable marker there.
  it.runIf(process.platform !== "win32" && process.getuid?.() !== 0)(
    "reports inaccessible legacy markers while preserving package files",
    async () => {
      const stateDir = retentionTempDirs.make("openclaw-retention-");
      const npmDir = path.join(stateDir, "npm");
      const packageDir = path.join(npmDir, "node_modules", "@openclaw", "kept-plugin");
      fs.mkdirSync(packageDir, { recursive: true });
      await markRetainedManagedNpmInstall({
        packageDir,
        pluginId: "kept-plugin",
        reason: RETAINED_MANAGED_NPM_GENERATION_UPDATE_REASON,
      });
      const markerPath = resolveRetainedManagedNpmInstallMarkerPath(packageDir);
      const markerDir = path.dirname(markerPath);
      const onError = vi.fn();
      fs.chmodSync(markerDir, 0o000);

      try {
        expect(hasRetainedManagedNpmInstallMarker(packageDir)).toBe(true);
        await expect(
          cleanupRetainedManagedNpmInstallGenerations({ npmDir, onError }),
        ).resolves.toBe(0);
      } finally {
        fs.chmodSync(markerDir, 0o700);
      }

      expect(fs.existsSync(packageDir)).toBe(true);
      expect(fs.existsSync(markerPath)).toBe(true);
      expect(onError).toHaveBeenCalledOnce();
      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({ code: expect.stringMatching(/^(?:EACCES|EPERM)$/u) }),
        packageDir,
      );

      await expect(cleanupRetainedManagedNpmInstallGenerations({ npmDir })).resolves.toBe(1);
      expect(fs.existsSync(packageDir)).toBe(false);
    },
  );

  it("cleans staged Codex inference activation markers", async () => {
    const stateDir = retentionTempDirs.make("openclaw-retention-");
    const npmDir = path.join(stateDir, "npm");
    const projectRoot = resolvePluginNpmGenerationProjectDir({
      npmDir,
      packageName: "@openclaw/codex",
      generationKey: "inference-v1",
    });
    const packageDir = path.join(projectRoot, "node_modules", "@openclaw", "codex");
    fs.mkdirSync(packageDir, { recursive: true });
    await markRetainedManagedNpmInstall({
      packageDir,
      pluginId: "codex",
      reason: RETAINED_MANAGED_NPM_INFERENCE_ACTIVATION_REASON,
    });

    await expect(cleanupRetainedManagedNpmInstallGenerations({ npmDir })).resolves.toBe(1);
    expect(fs.existsSync(packageDir)).toBe(false);
  });

  it.each([
    RETAINED_MANAGED_NPM_DOCTOR_REPAIR_REASON,
    RETAINED_MANAGED_NPM_DOCTOR_MISSING_DEPENDENCIES_REASON,
    RETAINED_MANAGED_NPM_GENERATION_UPDATE_REASON,
    RETAINED_MANAGED_NPM_PLUGIN_SOURCE_CHANGE_REASON,
    RETAINED_MANAGED_NPM_INFERENCE_ACTIVATION_REASON,
  ])("cleans the canonical cleanup-eligible reason %s", async (reason) => {
    const stateDir = retentionTempDirs.make("openclaw-retention-contract-");
    const npmDir = path.join(stateDir, "npm");
    const packageDir = path.join(npmDir, "node_modules", "@openclaw", "retired-plugin");
    fs.mkdirSync(packageDir, { recursive: true });
    await markRetainedManagedNpmInstall({
      packageDir,
      pluginId: "retired-plugin",
      reason,
    });

    await expect(cleanupRetainedManagedNpmInstallGenerations({ npmDir })).resolves.toBe(1);
    expect(fs.existsSync(packageDir)).toBe(false);
  });
});

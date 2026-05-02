import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __testing, cleanupLegacyPluginDependencyState } from "./plugin-dependency-cleanup.js";

describe("cleanupLegacyPluginDependencyState", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-plugin-deps-cleanup-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("collects and removes legacy plugin dependency state without deleting runtime roots", async () => {
    const stateDir = path.join(tempDir, "state");
    const explicitStageDir = path.join(tempDir, "explicit-stage");
    const stateDirectory = path.join(tempDir, "systemd-state");
    const packageRoot = path.join(tempDir, "package");
    const legacyRuntimeRoot = path.join(stateDir, "plugin-runtime-deps");
    const legacyRuntimeVersionedRoot = path.join(legacyRuntimeRoot, "openclaw-2026.4.25-deadbeef");
    const legacyLocalRoot = path.join(stateDir, ".local", "bundled-plugin-runtime-deps");
    const legacyExtensionNodeModules = path.join(
      packageRoot,
      "dist",
      "extensions",
      "demo",
      "node_modules",
    );
    const legacyManifest = path.join(
      packageRoot,
      "extensions",
      "demo",
      ".openclaw-runtime-deps.json",
    );
    const stateDirectoryRuntimeRoot = path.join(stateDirectory, "plugin-runtime-deps");
    const stateDirectoryVersionedRoot = path.join(
      stateDirectoryRuntimeRoot,
      "openclaw-2026.4.25-feedface",
    );

    await fs.mkdir(path.join(legacyRuntimeVersionedRoot, "node_modules"), { recursive: true });
    await fs.mkdir(legacyLocalRoot, { recursive: true });
    await fs.mkdir(legacyExtensionNodeModules, { recursive: true });
    await fs.mkdir(path.dirname(legacyManifest), { recursive: true });
    await fs.writeFile(legacyManifest, "{}");
    await fs.mkdir(explicitStageDir, { recursive: true });
    await fs.mkdir(path.join(stateDirectoryVersionedRoot, "node_modules"), { recursive: true });

    const env = {
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_PLUGIN_STAGE_DIR: explicitStageDir,
      STATE_DIRECTORY: stateDirectory,
    };
    const targets = await __testing.collectLegacyPluginDependencyTargets(env, { packageRoot });
    expect(targets).toEqual(
      expect.arrayContaining([
        legacyRuntimeVersionedRoot,
        legacyLocalRoot,
        legacyExtensionNodeModules,
        legacyManifest,
        explicitStageDir,
        stateDirectoryVersionedRoot,
      ]),
    );
    expect(targets).not.toContain(legacyRuntimeRoot);
    expect(targets).not.toContain(stateDirectoryRuntimeRoot);

    const result = await cleanupLegacyPluginDependencyState({ env, packageRoot });

    expect(result.warnings).toEqual([]);
    expect(result.changes.length).toBeGreaterThanOrEqual(6);
    await expect(fs.stat(legacyRuntimeRoot)).resolves.toBeTruthy();
    await expect(fs.stat(legacyRuntimeVersionedRoot)).rejects.toThrow();
    await expect(fs.stat(legacyLocalRoot)).rejects.toThrow();
    await expect(fs.stat(legacyExtensionNodeModules)).rejects.toThrow();
    await expect(fs.stat(legacyManifest)).rejects.toThrow();
    await expect(fs.stat(explicitStageDir)).rejects.toThrow();
    await expect(fs.stat(stateDirectoryRuntimeRoot)).resolves.toBeTruthy();
    await expect(fs.stat(stateDirectoryVersionedRoot)).rejects.toThrow();
  });

  it("prunes stale versioned runtime deps without a current root and preserves local data", async () => {
    const stateDir = path.join(tempDir, "state");
    const packageRoot = path.join(tempDir, "package");
    const runtimeRoot = path.join(stateDir, "plugin-runtime-deps");
    const staleRoot = path.join(runtimeRoot, "openclaw-2026.4.25-deadbeef");
    const stalePluginRoot = path.join(runtimeRoot, "openclaw-2026.4.25-discord");
    const staleBetaPluginRoot = path.join(runtimeRoot, "openclaw-2026.4.25-beta.1-telegram");
    const legacyPluginRoot = path.join(runtimeRoot, "discord");
    const localVersionLikeRoot = path.join(runtimeRoot, "openclaw-local-data");
    const localDataFile = path.join(runtimeRoot, "README.local");
    const symlinkTarget = path.join(tempDir, "..", "external-local-data");
    const symlinkPath = path.join(runtimeRoot, "local-link");

    await fs.mkdir(path.join(staleRoot, "node_modules", "stale-dep"), { recursive: true });
    await fs.mkdir(path.join(stalePluginRoot, "node_modules", "stale-dep"), {
      recursive: true,
    });
    await fs.mkdir(path.join(staleBetaPluginRoot, "node_modules", "stale-dep"), {
      recursive: true,
    });
    await fs.mkdir(path.join(legacyPluginRoot, "node_modules", "legacy-dep"), {
      recursive: true,
    });
    await fs.mkdir(localVersionLikeRoot, { recursive: true });
    await fs.writeFile(localDataFile, "keep me\n");
    await fs.symlink(symlinkTarget, symlinkPath);
    await fs.mkdir(packageRoot, { recursive: true });
    await fs.writeFile(
      path.join(packageRoot, "package.json"),
      `${JSON.stringify({ name: "openclaw", version: "2026.4.29" }, null, 2)}\n`,
    );

    const result = await cleanupLegacyPluginDependencyState({
      env: { OPENCLAW_STATE_DIR: stateDir },
      packageRoot,
    });

    expect(result.warnings).toEqual([]);
    expect(result.changes).toEqual(
      expect.arrayContaining([`Removed legacy plugin dependency state: ${staleRoot}`]),
    );
    expect(result.changes).toEqual(
      expect.arrayContaining([
        `Removed legacy plugin dependency state: ${stalePluginRoot}`,
        `Removed legacy plugin dependency state: ${staleBetaPluginRoot}`,
      ]),
    );
    expect(result.changes).not.toContain(
      `Removed legacy plugin dependency state: ${legacyPluginRoot}`,
    );
    expect(result.changes).not.toContain(
      `Removed legacy plugin dependency state: ${localVersionLikeRoot}`,
    );
    expect(result.changes).not.toContain(
      `Removed legacy plugin dependency state: ${localDataFile}`,
    );
    expect(result.changes).not.toContain(`Removed legacy plugin dependency state: ${symlinkPath}`);
    await expect(fs.stat(staleRoot)).rejects.toThrow();
    await expect(fs.stat(stalePluginRoot)).rejects.toThrow();
    await expect(fs.stat(staleBetaPluginRoot)).rejects.toThrow();
    await expect(fs.stat(legacyPluginRoot)).resolves.toBeTruthy();
    await expect(fs.stat(localVersionLikeRoot)).resolves.toBeTruthy();
    await expect(fs.stat(localDataFile)).resolves.toBeTruthy();
    await expect(fs.lstat(symlinkPath)).resolves.toBeTruthy();
    await expect(fs.stat(runtimeRoot)).resolves.toBeTruthy();
  });

  it("preserves current package and non-versioned runtime deps while pruning stale versioned siblings", async () => {
    const stateDir = path.join(tempDir, "state");
    const packageRoot = path.join(tempDir, "package");
    const runtimeRoot = path.join(stateDir, "plugin-runtime-deps");
    const currentRoot = path.join(runtimeRoot, "openclaw-2026.4.29-a1b2c3d4");
    const currentPluginRoot = path.join(runtimeRoot, "openclaw-2026.4.29-microsoft-teams");
    const staleRoot = path.join(runtimeRoot, "openclaw-2026.4.25-deadbeef");
    const stalePluginRoot = path.join(runtimeRoot, "openclaw-2026.4.25-microsoft-teams");
    const legacyPluginRoot = path.join(runtimeRoot, "discord");
    const localDataFile = path.join(runtimeRoot, "README.local");
    const symlinkTarget = path.join(tempDir, "..", "external-local-data");
    const symlinkPath = path.join(runtimeRoot, "local-link");

    await fs.mkdir(path.join(currentRoot, "node_modules", "current-dep"), { recursive: true });
    await fs.mkdir(path.join(currentPluginRoot, "node_modules", "current-dep"), {
      recursive: true,
    });
    await fs.mkdir(path.join(staleRoot, "node_modules", "stale-dep"), { recursive: true });
    await fs.mkdir(path.join(stalePluginRoot, "node_modules", "stale-dep"), {
      recursive: true,
    });
    await fs.mkdir(path.join(legacyPluginRoot, "node_modules", "legacy-dep"), {
      recursive: true,
    });
    await fs.writeFile(localDataFile, "keep me\n");
    await fs.symlink(symlinkTarget, symlinkPath);
    await fs.mkdir(packageRoot, { recursive: true });
    await fs.writeFile(
      path.join(packageRoot, "package.json"),
      `${JSON.stringify({ name: "openclaw", version: "2026.4.29" }, null, 2)}\n`,
    );

    const result = await cleanupLegacyPluginDependencyState({
      env: { OPENCLAW_STATE_DIR: stateDir },
      packageRoot,
    });

    expect(result.warnings).toEqual([]);
    expect(result.changes).toEqual(
      expect.arrayContaining([`Removed legacy plugin dependency state: ${staleRoot}`]),
    );
    expect(result.changes).toEqual(
      expect.arrayContaining([`Removed legacy plugin dependency state: ${stalePluginRoot}`]),
    );
    expect(result.changes).not.toContain(
      `Removed legacy plugin dependency state: ${legacyPluginRoot}`,
    );
    expect(result.changes).not.toContain(
      `Removed legacy plugin dependency state: ${localDataFile}`,
    );
    expect(result.changes).not.toContain(`Removed legacy plugin dependency state: ${symlinkPath}`);
    await expect(fs.stat(currentRoot)).resolves.toBeTruthy();
    await expect(fs.stat(currentPluginRoot)).resolves.toBeTruthy();
    await expect(fs.stat(staleRoot)).rejects.toThrow();
    await expect(fs.stat(stalePluginRoot)).rejects.toThrow();
    await expect(fs.stat(legacyPluginRoot)).resolves.toBeTruthy();
    await expect(fs.stat(localDataFile)).resolves.toBeTruthy();
    await expect(fs.lstat(symlinkPath)).resolves.toBeTruthy();
    await expect(fs.stat(runtimeRoot)).resolves.toBeTruthy();
  });

  it("prunes only stale versioned children when explicit stage dir is a runtime deps root", async () => {
    const packageRoot = path.join(tempDir, "package");
    const explicitStageRoot = path.join(tempDir, "plugin-runtime-deps");
    const currentRoot = path.join(explicitStageRoot, "openclaw-2026.4.29-a1b2c3d4");
    const staleRoot = path.join(explicitStageRoot, "openclaw-2026.4.25-deadbeef");
    const legacyPluginRoot = path.join(explicitStageRoot, "discord");
    const localDataFile = path.join(explicitStageRoot, "README.local");
    const symlinkTarget = path.join(tempDir, "..", "external-local-data");
    const symlinkPath = path.join(explicitStageRoot, "local-link");

    await fs.mkdir(path.join(currentRoot, "node_modules", "current-dep"), { recursive: true });
    await fs.mkdir(path.join(staleRoot, "node_modules", "stale-dep"), { recursive: true });
    await fs.mkdir(path.join(legacyPluginRoot, "node_modules", "legacy-dep"), {
      recursive: true,
    });
    await fs.writeFile(localDataFile, "keep me\n");
    await fs.symlink(symlinkTarget, symlinkPath);
    await fs.mkdir(packageRoot, { recursive: true });
    await fs.writeFile(
      path.join(packageRoot, "package.json"),
      `${JSON.stringify({ name: "openclaw", version: "2026.4.29" }, null, 2)}\n`,
    );

    const env = { OPENCLAW_PLUGIN_STAGE_DIR: explicitStageRoot };
    const targets = await __testing.collectLegacyPluginDependencyTargets(env, { packageRoot });
    expect(targets).toContain(staleRoot);
    expect(targets).not.toContain(explicitStageRoot);
    expect(targets).not.toContain(currentRoot);
    expect(targets).not.toContain(legacyPluginRoot);
    expect(targets).not.toContain(localDataFile);
    expect(targets).not.toContain(symlinkPath);

    const result = await cleanupLegacyPluginDependencyState({ env, packageRoot });

    expect(result.warnings).toEqual([]);
    expect(result.changes).toEqual(
      expect.arrayContaining([`Removed legacy plugin dependency state: ${staleRoot}`]),
    );
    expect(result.changes).not.toContain(
      `Removed legacy plugin dependency state: ${explicitStageRoot}`,
    );
    expect(result.changes).not.toContain(
      `Removed legacy plugin dependency state: ${legacyPluginRoot}`,
    );
    expect(result.changes).not.toContain(
      `Removed legacy plugin dependency state: ${localDataFile}`,
    );
    expect(result.changes).not.toContain(`Removed legacy plugin dependency state: ${symlinkPath}`);
    await expect(fs.stat(currentRoot)).resolves.toBeTruthy();
    await expect(fs.stat(staleRoot)).rejects.toThrow();
    await expect(fs.stat(legacyPluginRoot)).resolves.toBeTruthy();
    await expect(fs.stat(localDataFile)).resolves.toBeTruthy();
    await expect(fs.lstat(symlinkPath)).resolves.toBeTruthy();
    await expect(fs.stat(explicitStageRoot)).resolves.toBeTruthy();
  });
});

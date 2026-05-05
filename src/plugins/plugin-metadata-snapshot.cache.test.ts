import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearCurrentPluginMetadataSnapshotState } from "./current-plugin-metadata-state.js";
import { writePersistedInstalledPluginIndexSync } from "./installed-plugin-index-store.js";
import { loadPluginMetadataSnapshot } from "./plugin-metadata-snapshot.js";

const tempRoots: string[] = [];

function createBundledPluginRoot(pluginId: string): { root: string; extensionsRoot: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-plugin-metadata-cache-"));
  tempRoots.push(root);
  const extensionsRoot = path.join(root, "extensions");
  const pluginRoot = path.join(extensionsRoot, pluginId);
  fs.mkdirSync(pluginRoot, { recursive: true });
  fs.writeFileSync(
    path.join(pluginRoot, "openclaw.plugin.json"),
    `${JSON.stringify(
      {
        id: pluginId,
        configSchema: {
          type: "object",
          additionalProperties: true,
        },
      },
      null,
      2,
    )}\n`,
  );
  fs.writeFileSync(path.join(pluginRoot, "index.js"), "module.exports = { register() {} };\n");
  return { root, extensionsRoot };
}

function createEnv(extensionsRoot: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    VITEST: "1",
    OPENCLAW_BUNDLED_PLUGINS_DIR: extensionsRoot,
    OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
  };
}

describe("loadPluginMetadataSnapshot cache", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-05T00:00:00Z"));
    clearCurrentPluginMetadataSnapshotState();
  });

  afterEach(() => {
    clearCurrentPluginMetadataSnapshotState();
    vi.useRealTimers();
    for (const root of tempRoots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns the same snapshot within the metadata cache ttl", () => {
    const { extensionsRoot } = createBundledPluginRoot("metadata-cache-ttl");
    const params = {
      config: {},
      env: createEnv(extensionsRoot),
    };

    const first = loadPluginMetadataSnapshot(params);
    const second = loadPluginMetadataSnapshot(params);

    expect(second).toBe(first);
  });

  it("refreshes snapshots after the metadata cache ttl", () => {
    const { extensionsRoot } = createBundledPluginRoot("metadata-cache-expiry");
    const params = {
      config: {},
      env: createEnv(extensionsRoot),
    };

    const first = loadPluginMetadataSnapshot(params);
    vi.advanceTimersByTime(5_001);
    const second = loadPluginMetadataSnapshot(params);

    expect(second).not.toBe(first);
  });

  it("does not reuse cached snapshots across workspace scope", () => {
    const { root, extensionsRoot } = createBundledPluginRoot("metadata-cache-scope");
    const env = createEnv(extensionsRoot);

    const first = loadPluginMetadataSnapshot({
      config: {},
      env,
      workspaceDir: path.join(root, "workspace-a"),
    });
    const second = loadPluginMetadataSnapshot({
      config: {},
      env,
      workspaceDir: path.join(root, "workspace-b"),
    });

    expect(second).not.toBe(first);
  });

  it("clears the metadata cache when the installed plugin index is persisted", () => {
    const { root, extensionsRoot } = createBundledPluginRoot("metadata-cache-clear");
    const stateDir = path.join(root, "state");
    const params = {
      config: {},
      env: createEnv(extensionsRoot),
      stateDir,
    };

    const first = loadPluginMetadataSnapshot(params);
    writePersistedInstalledPluginIndexSync(first.index, { stateDir });
    const second = loadPluginMetadataSnapshot(params);

    expect(second).not.toBe(first);
  });
});

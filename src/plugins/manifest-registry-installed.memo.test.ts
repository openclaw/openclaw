/**
 * Focused tests for the LRU memoization layer added to
 * loadPluginManifestRegistryForInstalledIndex.
 *
 * These tests verify:
 * - Cache hit returns the same object reference.
 * - Different pluginIds subsets produce separate entries (no cross-bleed).
 * - Different policyHash invalidates.
 * - Mutation of installs.json mtime invalidates the entry.
 * - clearCurrentPluginMetadataSnapshotState() (via clearManifestRegistryInstalledCache) clears the cache.
 * - LRU eviction at the configured cap (16 entries).
 *
 * Uses a dedicated temp directory per test.  No real ~/.openclaw files are read
 * or written — installs.json is placed in a temp stateDir when needed.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writePersistedInstalledPluginIndexSync } from "./installed-plugin-index-store.js";
import type { InstalledPluginIndex } from "./installed-plugin-index.js";
import {
  clearManifestRegistryInstalledCache,
  loadPluginManifestRegistryForInstalledIndex,
} from "./manifest-registry-installed.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "./test-helpers/fs-fixtures.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];

afterEach(() => {
  cleanupTrackedTempDirs(tempDirs);
  clearManifestRegistryInstalledCache();
});

function makeTempDir(): string {
  return makeTrackedTempDir("openclaw-memo-test", tempDirs);
}

function writePlugin(rootDir: string, pluginId: string, modelPrefix: string): void {
  fs.mkdirSync(rootDir, { recursive: true });
  fs.writeFileSync(
    path.join(rootDir, "index.ts"),
    "throw new Error('runtime entry should not load while reading manifests');\n",
    "utf8",
  );
  fs.writeFileSync(
    path.join(rootDir, "openclaw.plugin.json"),
    JSON.stringify({
      id: pluginId,
      configSchema: { type: "object" },
      providers: [pluginId],
      modelSupport: { modelPrefixes: [modelPrefix] },
    }),
    "utf8",
  );
}

function createIndex(
  rootDir: string,
  overrides: Partial<InstalledPluginIndex> = {},
): InstalledPluginIndex {
  return {
    version: 1,
    hostContractVersion: "2026.4.25",
    compatRegistryVersion: "compat-v1",
    migrationVersion: 1,
    policyHash: "policy-v1",
    generatedAtMs: 1777118400000,
    installRecords: {},
    plugins: [
      {
        pluginId: "test-plugin",
        manifestPath: path.join(rootDir, "openclaw.plugin.json"),
        manifestHash: "manifest-hash",
        source: path.join(rootDir, "index.ts"),
        rootDir,
        origin: "global",
        enabled: true,
        startup: {
          sidecar: false,
          memory: false,
          deferConfiguredChannelFullLoadUntilAfterListen: false,
          agentHarnesses: [],
        },
        compat: [],
      },
    ],
    diagnostics: [],
    ...overrides,
  };
}

const BASE_ENV = {
  OPENCLAW_VERSION: "2026.4.25",
  VITEST: "true",
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("loadPluginManifestRegistryForInstalledIndex — LRU memoization", () => {
  it("cache hit returns the same object reference for identical params", () => {
    const rootDir = makeTempDir();
    writePlugin(rootDir, "test-plugin", "test-");
    const index = createIndex(rootDir);

    const first = loadPluginManifestRegistryForInstalledIndex({
      index,
      env: BASE_ENV,
      includeDisabled: true,
    });
    const second = loadPluginManifestRegistryForInstalledIndex({
      index,
      env: BASE_ENV,
      includeDisabled: true,
    });

    expect(second).toBe(first);
  });

  it("different pluginIds subsets produce separate cache entries (no cross-bleed)", () => {
    const rootDirA = makeTempDir();
    const rootDirB = path.join(makeTempDir(), "plugin-b");
    writePlugin(rootDirA, "plugin-a", "prefix-a-");
    writePlugin(rootDirB, "plugin-b", "prefix-b-");

    const index: InstalledPluginIndex = {
      version: 1,
      hostContractVersion: "2026.4.25",
      compatRegistryVersion: "compat-v1",
      migrationVersion: 1,
      policyHash: "policy-v1",
      generatedAtMs: 1777118400000,
      installRecords: {},
      plugins: [
        {
          pluginId: "plugin-a",
          manifestPath: path.join(rootDirA, "openclaw.plugin.json"),
          manifestHash: "hash-a",
          source: path.join(rootDirA, "index.ts"),
          rootDir: rootDirA,
          origin: "global",
          enabled: true,
          startup: {
            sidecar: false,
            memory: false,
            deferConfiguredChannelFullLoadUntilAfterListen: false,
            agentHarnesses: [],
          },
          compat: [],
        },
        {
          pluginId: "plugin-b",
          manifestPath: path.join(rootDirB, "openclaw.plugin.json"),
          manifestHash: "hash-b",
          source: path.join(rootDirB, "index.ts"),
          rootDir: rootDirB,
          origin: "global",
          enabled: true,
          startup: {
            sidecar: false,
            memory: false,
            deferConfiguredChannelFullLoadUntilAfterListen: false,
            agentHarnesses: [],
          },
          compat: [],
        },
      ],
      diagnostics: [],
    };

    const onlyA = loadPluginManifestRegistryForInstalledIndex({
      index,
      env: BASE_ENV,
      pluginIds: ["plugin-a"],
    });
    const onlyB = loadPluginManifestRegistryForInstalledIndex({
      index,
      env: BASE_ENV,
      pluginIds: ["plugin-b"],
    });

    expect(onlyA).not.toBe(onlyB);
    expect(onlyA.plugins.map((p) => p.id)).toEqual(["plugin-a"]);
    expect(onlyB.plugins.map((p) => p.id)).toEqual(["plugin-b"]);

    // Confirm each is cached independently
    const onlyAAgain = loadPluginManifestRegistryForInstalledIndex({
      index,
      env: BASE_ENV,
      pluginIds: ["plugin-a"],
    });
    expect(onlyAAgain).toBe(onlyA);
  });

  it("different policyHash produces a separate cache entry", () => {
    const rootDir = makeTempDir();
    writePlugin(rootDir, "test-plugin", "test-");

    const indexV1 = createIndex(rootDir, { policyHash: "policy-v1" });
    const indexV2 = createIndex(rootDir, { policyHash: "policy-v2" });

    const first = loadPluginManifestRegistryForInstalledIndex({
      index: indexV1,
      env: BASE_ENV,
      includeDisabled: true,
    });
    const second = loadPluginManifestRegistryForInstalledIndex({
      index: indexV2,
      env: BASE_ENV,
      includeDisabled: true,
    });

    // Different keys → different entries, not the same reference
    expect(second).not.toBe(first);

    // Each is independently cached
    const firstAgain = loadPluginManifestRegistryForInstalledIndex({
      index: indexV1,
      env: BASE_ENV,
      includeDisabled: true,
    });
    expect(firstAgain).toBe(first);
  });

  it("installs.json mtime change invalidates the cache entry", () => {
    const rootDir = makeTempDir();
    const stateDir = makeTempDir();
    writePlugin(rootDir, "test-plugin", "test-");
    const index = createIndex(rootDir);

    // Write an installs.json into the temp stateDir so we can control its mtime.
    writePersistedInstalledPluginIndexSync(index, { stateDir });
    // Re-clear because writePersistedInstalledPluginIndexSync calls clearManifestRegistryInstalledCache.
    clearManifestRegistryInstalledCache();

    const env = { ...BASE_ENV, OPENCLAW_STATE_DIR: stateDir };

    const first = loadPluginManifestRegistryForInstalledIndex({
      index,
      env,
      includeDisabled: true,
    });
    // Confirm it was cached.
    expect(loadPluginManifestRegistryForInstalledIndex({ index, env, includeDisabled: true })).toBe(
      first,
    );

    // Bump installs.json mtime to simulate a background install.
    const indexFilePath = path.join(stateDir, "plugins", "installs.json");
    const futureTime = new Date(Date.now() + 10_000);
    fs.utimesSync(indexFilePath, futureTime, futureTime);

    // Next call should detect the stale mtime and rebuild (different reference).
    const second = loadPluginManifestRegistryForInstalledIndex({
      index,
      env,
      includeDisabled: true,
    });
    expect(second).not.toBe(first);
  });

  it("clearManifestRegistryInstalledCache() evicts all entries", () => {
    const rootDir = makeTempDir();
    writePlugin(rootDir, "test-plugin", "test-");
    const index = createIndex(rootDir);

    const first = loadPluginManifestRegistryForInstalledIndex({
      index,
      env: BASE_ENV,
      includeDisabled: true,
    });

    clearManifestRegistryInstalledCache();

    const second = loadPluginManifestRegistryForInstalledIndex({
      index,
      env: BASE_ENV,
      includeDisabled: true,
    });

    expect(second).not.toBe(first);
  });

  it("writePersistedInstalledPluginIndexSync() clears the cache (integration with store)", () => {
    const rootDir = makeTempDir();
    const stateDir = makeTempDir();
    writePlugin(rootDir, "test-plugin", "test-");
    const index = createIndex(rootDir);
    const env = { ...BASE_ENV, OPENCLAW_STATE_DIR: stateDir };

    // Prime the cache.
    writePersistedInstalledPluginIndexSync(index, { stateDir });
    clearManifestRegistryInstalledCache(); // reset after the write above

    const first = loadPluginManifestRegistryForInstalledIndex({
      index,
      env,
      includeDisabled: true,
    });
    // Confirm cached.
    expect(loadPluginManifestRegistryForInstalledIndex({ index, env, includeDisabled: true })).toBe(
      first,
    );

    // A persist-write should clear the cache.
    writePersistedInstalledPluginIndexSync(index, { stateDir });

    const second = loadPluginManifestRegistryForInstalledIndex({
      index,
      env,
      includeDisabled: true,
    });
    expect(second).not.toBe(first);
  });

  it("LRU evicts the least-recently-used entry when the cache reaches capacity (16)", () => {
    const CACHE_CAP = 16;
    // We need 17 distinct cache keys → 17 distinct policyHash values.
    const entries: Array<{ rootDir: string; index: InstalledPluginIndex }> = [];
    for (let i = 0; i <= CACHE_CAP; i++) {
      const rootDir = makeTempDir();
      writePlugin(rootDir, "test-plugin", `prefix-${i}-`);
      entries.push({
        rootDir,
        index: createIndex(rootDir, { policyHash: `policy-${i}` }),
      });
    }

    // Fill the cache with entries 0..15 (CACHE_CAP entries).
    const registries: PluginManifestRegistry[] = [];
    for (let i = 0; i < CACHE_CAP; i++) {
      registries.push(
        loadPluginManifestRegistryForInstalledIndex({
          index: entries[i].index,
          env: BASE_ENV,
          includeDisabled: true,
        }),
      );
    }

    // Touch entry 0 to make it the most recently used (moves it to the end).
    loadPluginManifestRegistryForInstalledIndex({
      index: entries[0].index,
      env: BASE_ENV,
      includeDisabled: true,
    });

    // Insert entry 16 → cache is over capacity, should evict the LRU entry (entry 1).
    const registry16 = loadPluginManifestRegistryForInstalledIndex({
      index: entries[CACHE_CAP].index,
      env: BASE_ENV,
      includeDisabled: true,
    });

    // Entry 16 should now be cached.
    expect(
      loadPluginManifestRegistryForInstalledIndex({
        index: entries[CACHE_CAP].index,
        env: BASE_ENV,
        includeDisabled: true,
      }),
    ).toBe(registry16);

    // Entry 0 should still be cached (we touched it recently).
    expect(
      loadPluginManifestRegistryForInstalledIndex({
        index: entries[0].index,
        env: BASE_ENV,
        includeDisabled: true,
      }),
    ).toBe(registries[0]);

    // Entry 1 should have been evicted (LRU).
    const evictedResult = loadPluginManifestRegistryForInstalledIndex({
      index: entries[1].index,
      env: BASE_ENV,
      includeDisabled: true,
    });
    expect(evictedResult).not.toBe(registries[1]);
  });
});

// Keep the type import happy for the test above.
type PluginManifestRegistry = ReturnType<typeof loadPluginManifestRegistryForInstalledIndex>;

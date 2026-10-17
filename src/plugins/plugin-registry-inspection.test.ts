import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import type { PluginCandidate } from "./discovery.js";
import {
  refreshPersistedInstalledPluginIndex,
  writePersistedInstalledPluginIndex,
} from "./installed-plugin-index-store-write.js";
import { readPersistedInstalledPluginIndex } from "./installed-plugin-index-store.js";
import type { InstalledPluginIndex } from "./installed-plugin-index.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";
import { diffPluginRegistryRecords } from "./plugin-registry-comparison.js";
import { refreshPluginRegistry } from "./plugin-registry-refresh.js";
import {
  inspectPluginRegistry,
  loadPluginRegistrySnapshotWithMetadata,
} from "./plugin-registry.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "./test-helpers/fs-fixtures.js";
import { writeManagedNpmPlugin } from "./test-helpers/managed-npm-plugin.js";

const tempDirs: string[] = [];

function writeJson(filePath: string, data: unknown) {
  fs.writeFileSync(filePath, JSON.stringify(data), "utf8");
}

beforeEach(() => {
  clearPluginMetadataLifecycleCaches();
});

afterEach(async () => {
  clearPluginMetadataLifecycleCaches();
  await closeStateDatabaseForTest();
  cleanupTrackedTempDirs(tempDirs);
});

function makeTempDir(): string {
  return makeTrackedTempDir("openclaw-plugin-registry-inspection", tempDirs);
}

function hermeticEnv(): NodeJS.ProcessEnv {
  return { OPENCLAW_BUNDLED_PLUGINS_DIR: undefined, OPENCLAW_VERSION: "2026.4.25", VITEST: "true" };
}

function createCandidate(rootDir: string): PluginCandidate {
  const source = path.join(rootDir, "index.ts");
  fs.writeFileSync(source, "export default { register() {} };\n", "utf8");
  writeJson(path.join(rootDir, "openclaw.plugin.json"), {
    id: "demo",
    name: "Demo",
    configSchema: { type: "object" },
  });
  return { idHint: "demo", source, rootDir, origin: "global" };
}

function createPackagedCandidate(rootDir: string): PluginCandidate {
  const candidate = createCandidate(rootDir);
  writeJson(path.join(rootDir, "package.json"), { name: "demo", version: "1.0.0" });
  return { ...candidate, packageDir: rootDir, packageName: "demo", packageVersion: "1.0.0" };
}

function createEmptyIndex(stateDir: string): InstalledPluginIndex {
  return {
    version: 1,
    hostContractVersion: "2026.4.25",
    compatRegistryVersion: "compat-v1",
    migrationVersion: 1,
    policyHash: "policy-v1",
    generatedAtMs: 1777118400000,
    installRecords: {
      missing: {
        source: "npm",
        spec: "missing-plugin@1.0.0",
        installPath: path.join(stateDir, "plugins", "missing"),
      },
    },
    plugins: [],
    diagnostics: [],
  };
}

function candidateFixture() {
  const stateDir = makeTempDir();
  const pluginDir = makeTempDir();
  return {
    stateDir,
    pluginDir,
    candidates: [createCandidate(pluginDir)],
    env: hermeticEnv(),
    config: {},
  };
}

function expectFreshness(
  inspection: Awaited<ReturnType<typeof inspectPluginRegistry>>,
  state: "fresh" | "missing" | "stale",
  refreshReasons: typeof inspection.refreshReasons,
) {
  expect({ state: inspection.state, refreshReasons: inspection.refreshReasons }).toEqual({
    state,
    refreshReasons,
  });
}

async function installedFixture(sourceDir?: string) {
  const stateDir = makeTempDir();
  const pluginDir = path.join(stateDir, "extensions", "demo");
  fs.mkdirSync(pluginDir, { recursive: true });
  const candidate = createPackagedCandidate(pluginDir);
  const env = {
    ...hermeticEnv(),
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    OPENCLAW_STATE_DIR: stateDir,
  };
  const config = { plugins: { entries: { demo: { enabled: true } } } };
  await refreshPluginRegistry({
    reason: "manual",
    stateDir,
    config,
    env,
    installRecords: {
      demo: {
        source: "path",
        sourcePath: sourceDir ?? pluginDir,
        installPath: pluginDir,
        version: "1.0.0",
      },
    },
  });
  return { stateDir, pluginDir, candidate, env, config };
}

describe("plugin registry inspection", () => {
  it.each([false, true])(
    "revalidates a configured-path warning after cold inspection (removed: %s)",
    async (removed) => {
      const stateDir = makeTempDir();
      const missingPath = path.join(stateDir, "missing-plugin");
      const env = {
        ...hermeticEnv(),
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      };
      const configured = { plugins: { load: { paths: [missingPath] } } };
      const refreshed = await refreshPluginRegistry({
        reason: "manual",
        stateDir,
        config: configured,
        env,
      });
      const warning = { code: "configured-plugin-path-unavailable", source: missingPath };
      expect(refreshed.diagnostics).toContainEqual(expect.objectContaining(warning));
      expect(
        refreshed.diagnostics.find((diagnostic) => diagnostic.source === missingPath)?.pluginId,
      ).toBeUndefined();

      const config = removed ? {} : configured;
      for (let inspectionNumber = 0; inspectionNumber < 2; inspectionNumber += 1) {
        await closeOpenClawStateDatabaseAsync();
        clearPluginMetadataLifecycleCaches();
        const inspection = await inspectPluginRegistry({ stateDir, config, env });
        // Inspection changes the returned view, not the persisted refresh ledger.
        expect(inspection.persisted?.diagnostics).toContainEqual(expect.objectContaining(warning));
        expect
          .soft(
            inspection.current.diagnostics.some(
              (diagnostic) => diagnostic.code === warning.code && diagnostic.source === missingPath,
            ),
          )
          .toBe(!removed);
      }

      const repaired = await refreshPluginRegistry({ reason: "manual", stateDir, config, env });
      expect(
        repaired.diagnostics.some(
          (diagnostic) => diagnostic.code === warning.code && diagnostic.source === missingPath,
        ),
      ).toBe(!removed);
    },
  );

  it("derives without persisted install records when persisted reads are disabled", async () => {
    const stateDir = makeTempDir();
    const pluginDir = makeTempDir();
    const candidate = createCandidate(pluginDir);
    await writePersistedInstalledPluginIndex(createEmptyIndex(stateDir), { stateDir });

    const result = loadPluginRegistrySnapshotWithMetadata({
      stateDir,
      candidates: [candidate],
      env: hermeticEnv(),
      preferPersisted: false,
    });

    expect(result.source).toBe("derived");
    expect(result.snapshot.plugins.map((plugin) => plugin.pluginId)).toEqual(["demo"]);
    expect(result.snapshot.installRecords).not.toHaveProperty("missing");
  });

  it("reports missing, fresh, policy, and manifest freshness from the snapshot selector", async () => {
    const { pluginDir, ...params } = candidateFixture();
    expectFreshness(await inspectPluginRegistry(params), "missing", ["missing"]);
    await refreshPluginRegistry({ ...params, reason: "manual" });
    expectFreshness(await inspectPluginRegistry(params), "fresh", []);

    const policy = await inspectPluginRegistry({
      ...params,
      config: { plugins: { entries: { demo: { enabled: false } } } },
    });
    expectFreshness(policy, "stale", ["policy-changed"]);

    writeJson(path.join(pluginDir, "openclaw.plugin.json"), {
      id: "demo",
      name: "Demo",
      configSchema: { type: "object" },
      providers: ["demo-next"],
    });
    clearPluginMetadataLifecycleCaches();
    expectFreshness(await inspectPluginRegistry(params), "stale", ["stale-manifest"]);
  });

  it("agrees with snapshot selection when a packaged runtime entry changes", async () => {
    const stateDir = makeTempDir();
    const pluginDir = makeTempDir();
    const sourceCandidate = createCandidate(pluginDir);
    const env = hermeticEnv();
    await refreshPluginRegistry({ reason: "manual", stateDir, candidates: [sourceCandidate], env });
    const builtSource = path.join(pluginDir, "index.js");
    fs.writeFileSync(builtSource, "export default { register() {} };\n", "utf8");
    fs.rmSync(sourceCandidate.source);
    const builtCandidate = { ...sourceCandidate, source: builtSource };

    const snapshot = loadPluginRegistrySnapshotWithMetadata({
      stateDir,
      candidates: [builtCandidate],
      env,
    });
    const inspection = await inspectPluginRegistry({ stateDir, candidates: [builtCandidate], env });

    expect(snapshot.source).toBe("derived");
    expect(snapshot.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "persisted-registry-stale-source",
    ]);
    expect(inspection.state).toBe("stale");
    expect(inspection.refreshReasons).toEqual(["source-changed"]);
    expect(inspection.differences).toEqual([
      {
        pluginId: "demo",
        changed: ["record"],
        persistedSource: sourceCandidate.source,
        derivedSource: builtSource,
      },
    ]);
    expect(inspection.current.plugins[0]?.source).toBe(builtSource);
  });

  it("keeps an older registry fresh when current build metadata is not durable", async () => {
    const stateDir = makeTempDir();
    const pluginDir = makeTempDir();
    createPackagedCandidate(pluginDir);
    writeJson(path.join(pluginDir, "package.json"), {
      name: "demo",
      version: "1.0.0",
      openclaw: { extensions: ["./index.ts"], build: { openclawVersion: "2026.4.25" } },
    });
    const env = { ...hermeticEnv(), OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" };
    const config = { plugins: { load: { paths: [pluginDir] } } };
    const refreshed = await refreshPluginRegistry({ reason: "manual", stateDir, config, env });
    expect(expectDefined(refreshed.plugins[0], "refreshed plugin").packageBuild).toEqual({
      openclawVersion: "2026.4.25",
    });

    const persisted = expectDefined(
      await readPersistedInstalledPluginIndex({ stateDir }),
      "persisted plugin registry",
    );
    await writePersistedInstalledPluginIndex(
      {
        ...persisted,
        plugins: persisted.plugins.map(({ packageBuild: _packageBuild, ...plugin }) => plugin),
      },
      { stateDir },
    );

    const inspection = await inspectPluginRegistry({ stateDir, config, env });

    expect({
      state: inspection.state,
      refreshReasons: inspection.refreshReasons,
      differencePluginIds: inspection.differences.map((difference) => difference.pluginId),
    }).toEqual({ state: "fresh", refreshReasons: [], differencePluginIds: [] });
  });

  it("inspects package changes with fresh file facts", async () => {
    const sourceDir = makeTempDir();
    createPackagedCandidate(sourceDir);
    const { stateDir, pluginDir, candidate, env, config } = await installedFixture(sourceDir);
    writeJson(path.join(pluginDir, "package.json"), { name: "demo", version: "2.0.0" });
    writeJson(path.join(sourceDir, "package.json"), { name: "demo", version: "2.0.0" });

    const inspection = await inspectPluginRegistry({ stateDir, config, env });

    expect(inspection.state).toBe("stale");
    expect(inspection.refreshReasons).toEqual(["stale-package"]);
    expect(inspection.differences).toEqual([
      {
        pluginId: "demo",
        changed: ["record"],
        persistedSource: candidate.source,
        derivedSource: candidate.source,
      },
    ]);
  });

  it("names the changed facets when persisted and derived sources are identical", async () => {
    const { stateDir, candidate } = await installedFixture();
    const persisted = expectDefined(
      await readPersistedInstalledPluginIndex({ stateDir }),
      "persisted plugin registry",
    );
    const persistedInstall = expectDefined(persisted.installRecords.demo, "persisted install");
    const derived: InstalledPluginIndex = {
      ...persisted,
      installRecords: { demo: { ...persistedInstall, version: "1.1.0" } },
      diagnostics: [
        ...persisted.diagnostics,
        { level: "warn", code: "plugin-verification", pluginId: "demo", message: "moved" },
      ],
    };

    // Both source paths point at the same file; only the facets tell an operator what moved.
    expect(diffPluginRegistryRecords(persisted, derived, true, new Map())).toEqual([
      {
        pluginId: "demo",
        changed: ["install", "diagnostics"],
        persistedSource: candidate.source,
        derivedSource: candidate.source,
      },
    ]);
    expect(diffPluginRegistryRecords(persisted, persisted, true, new Map())).toEqual([]);
  });

  it("uses the configured system-agent workspace for the freshness verdict", async () => {
    const stateDir = makeTempDir();
    const workspaceDir = makeTempDir();
    const pluginDir = path.join(workspaceDir, ".openclaw", "extensions", "demo");
    fs.mkdirSync(pluginDir, { recursive: true });
    createCandidate(pluginDir);
    const env = { ...hermeticEnv(), OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" };
    const config = {
      agents: {
        ownership: "explicit" as const,
        defaults: { systemAgent: { agentId: "main" } },
        entries: { main: { workspace: workspaceDir } },
      },
    };
    await refreshPersistedInstalledPluginIndex({ reason: "manual", stateDir, config, env });

    const listSelection = loadPluginRegistrySnapshotWithMetadata({
      stateDir,
      workspaceDir,
      config,
      env,
    });
    const inspection = await inspectPluginRegistry({ stateDir, config, env });

    expect(listSelection.source).toBe("derived");
    expect(listSelection.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "persisted-registry-stale-source",
    ]);
    expect(inspection.state).toBe("stale");
    expect(inspection.refreshReasons).toEqual(["source-changed"]);
    expect(inspection.current.workspaceDir).toBe(workspaceDir);
    expect(inspection.current.plugins.map((plugin) => plugin.pluginId)).toEqual(["demo"]);

    await refreshPluginRegistry({ reason: "manual", stateDir, config, env });
    const repaired = await inspectPluginRegistry({ stateDir, config, env });
    expect(repaired.state).toBe("fresh");
    expect(repaired.refreshReasons).toEqual([]);
  });

  it("fails closed when refreshing a copied state root", async () => {
    const sourceStateDir = makeTempDir();
    const copiedStateDir = path.join(makeTempDir(), "copied-state");
    const externalDir = makeTempDir();
    createPackagedCandidate(externalDir);
    const packageName = "openclaw-copied-managed";
    const sourceManagedPath = writeManagedNpmPlugin({
      stateDir: sourceStateDir,
      packageName,
      pluginId: "copied-managed",
      version: "1.0.0",
    });
    const config = { plugins: { load: { paths: [externalDir] } } };

    await refreshPluginRegistry({
      reason: "manual",
      stateDir: sourceStateDir,
      config,
      env: { ...hermeticEnv(), OPENCLAW_STATE_DIR: sourceStateDir },
      installRecords: {
        "copied-managed": {
          source: "npm",
          spec: `${packageName}@1.0.0`,
          installPath: sourceManagedPath,
          resolvedName: packageName,
          resolvedVersion: "1.0.0",
        },
        demo: {
          source: "path",
          sourcePath: externalDir,
          installPath: externalDir,
          version: "1.0.0",
        },
      },
    });
    await closeOpenClawStateDatabaseAsync();
    clearPluginMetadataLifecycleCaches();
    fs.cpSync(sourceStateDir, copiedStateDir, { recursive: true });

    expect(fs.existsSync(sourceManagedPath)).toBe(true);
    await expect(
      refreshPluginRegistry({
        reason: "manual",
        stateDir: copiedStateDir,
        config,
        env: { ...hermeticEnv(), OPENCLAW_STATE_DIR: copiedStateDir },
      }),
    ).rejects.toThrow("cannot verify npm install ownership outside the selected state directory");
    const persisted = expectDefined(
      await readPersistedInstalledPluginIndex({ stateDir: copiedStateDir }),
      "copied plugin registry",
    );
    expect(persisted.installRecords["copied-managed"]?.installPath).toBe(sourceManagedPath);
    expect(persisted.installRecords.demo).toMatchObject({
      source: "path",
      sourcePath: externalDir,
      installPath: externalDir,
    });
  });
});

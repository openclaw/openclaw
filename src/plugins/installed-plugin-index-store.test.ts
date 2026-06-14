// Covers installed plugin index store persistence and recovery behavior.
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  closeOpenClawStateDatabaseForTest,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import type { PluginCandidate } from "./discovery.js";
import {
  inspectPersistedInstalledPluginIndex,
  readPersistedInstalledPluginIndex,
  refreshPersistedInstalledPluginIndex,
  resolveInstalledPluginIndexStorePath,
  writePersistedInstalledPluginIndex,
} from "./installed-plugin-index-store.js";
import type { InstalledPluginIndex } from "./installed-plugin-index.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "./test-helpers/fs-fixtures.js";
import { writeManagedNpmPlugin } from "./test-helpers/managed-npm-plugin.js";

const tempDirs: string[] = [];

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  cleanupTrackedTempDirs(tempDirs);
});

function makeTempDir() {
  return makeTrackedTempDir("openclaw-installed-plugin-index-store", tempDirs);
}

function createIndex(overrides: Partial<InstalledPluginIndex> = {}): InstalledPluginIndex {
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
        pluginId: "demo",
        manifestPath: "/plugins/demo/openclaw.plugin.json",
        manifestHash: "manifest-hash",
        rootDir: "/plugins/demo",
        origin: "global",
        enabled: true,
        syntheticAuthRefs: ["demo"],
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

function createCandidate(
  rootDir: string,
  options: { id?: string; configPaths?: readonly string[] } = {},
): PluginCandidate {
  const id = options.id ?? "demo";
  fs.writeFileSync(
    path.join(rootDir, "index.ts"),
    "throw new Error('runtime entry should not load while persisting installed plugin index');\n",
    "utf8",
  );
  fs.writeFileSync(
    path.join(rootDir, "openclaw.plugin.json"),
    JSON.stringify({
      id,
      name: id === "demo" ? "Demo" : "Next Demo",
      configSchema: { type: "object" },
      providers: [id],
      ...(options.configPaths ? { activation: { onConfigPaths: options.configPaths } } : {}),
    }),
    "utf8",
  );
  return {
    idHint: id,
    source: path.join(rootDir, "index.ts"),
    rootDir,
    origin: "global",
  };
}

function requirePersisted(index: InstalledPluginIndex | null): InstalledPluginIndex {
  if (!index) {
    throw new Error("Expected persisted installed plugin index");
  }
  return index;
}

function expectPluginIds(index: InstalledPluginIndex, expected: string[]) {
  expect(index.plugins.map((plugin) => plugin.pluginId)).toEqual(expected);
}

function expectPluginFields(
  index: InstalledPluginIndex,
  pluginId: string,
  expected: Record<string, unknown>,
) {
  const plugin = index.plugins.find((candidate) => candidate.pluginId === pluginId);
  if (!plugin) {
    throw new Error(`Missing plugin ${pluginId}`);
  }
  for (const [key, value] of Object.entries(expected)) {
    expect(plugin[key as keyof typeof plugin], key).toEqual(value);
  }
}

function expectInstallRecord(
  index: InstalledPluginIndex,
  pluginId: string,
  expected: Record<string, unknown>,
) {
  const record = index.installRecords[pluginId];
  if (!record) {
    throw new Error(`Missing install record ${pluginId}`);
  }
  for (const [key, value] of Object.entries(expected)) {
    expect(record[key as keyof typeof record], key).toEqual(value);
  }
}

function dropStartupConfigPaths(
  plugin: InstalledPluginIndex["plugins"][number],
): InstalledPluginIndex["plugins"][number] {
  return {
    ...plugin,
    startup: {
      sidecar: plugin.startup.sidecar,
      memory: plugin.startup.memory,
      deferConfiguredChannelFullLoadUntilAfterListen:
        plugin.startup.deferConfiguredChannelFullLoadUntilAfterListen,
      agentHarnesses: plugin.startup.agentHarnesses,
    },
  };
}

async function expectPersistedIndex(
  stateDir: string,
  expected: {
    refreshReason?: string;
    pluginIds?: string[];
    installRecords?: Record<string, Record<string, unknown>>;
  },
) {
  const persisted = requirePersisted(await readPersistedInstalledPluginIndex({ stateDir }));
  if (expected.refreshReason !== undefined) {
    expect(persisted.refreshReason).toBe(expected.refreshReason);
  }
  if (expected.pluginIds) {
    expectPluginIds(persisted, expected.pluginIds);
  }
  for (const [pluginId, fields] of Object.entries(expected.installRecords ?? {})) {
    expectInstallRecord(persisted, pluginId, fields);
  }
  return persisted;
}

function insertPersistedIndexRow(
  stateDir: string,
  values: {
    version?: number;
    migrationVersion?: number;
    installRecordsJson?: string;
    pluginsJson?: string;
    diagnosticsJson?: string;
  },
) {
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      db.prepare(
        `
          INSERT OR REPLACE INTO installed_plugin_index (
            index_key, version, host_contract_version, compat_registry_version,
            migration_version, policy_hash, generated_at_ms, refresh_reason,
            install_records_json, plugins_json, diagnostics_json, warning, updated_at_ms
          ) VALUES (
            'installed-plugin-index', @version, '2026.4.25', 'compat-v1',
            @migration_version, 'policy-hash', 123, NULL,
            @install_records_json, @plugins_json, @diagnostics_json, NULL, 123
          )
        `,
      ).run({
        version: values.version ?? 1,
        migration_version: values.migrationVersion ?? 1,
        install_records_json: values.installRecordsJson ?? "{}",
        plugins_json: values.pluginsJson ?? "[]",
        diagnostics_json: values.diagnosticsJson ?? "[]",
      });
    },
    { env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } },
  );
}

describe("installed plugin index persistence", () => {
  it("resolves the persisted index path to the shared state database", () => {
    const stateDir = makeTempDir();

    expect(resolveInstalledPluginIndexStorePath({ stateDir })).toBe(
      path.join(stateDir, "state", "openclaw.sqlite"),
    );
  });

  it("writes and reads the installed plugin index atomically", async () => {
    const stateDir = makeTempDir();
    const filePath = resolveInstalledPluginIndexStorePath({ stateDir });
    const index = createIndex();

    await expect(writePersistedInstalledPluginIndex(index, { stateDir })).resolves.toBe(filePath);

    if (process.platform !== "win32") {
      expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
    }
    const persisted = requirePersisted(await readPersistedInstalledPluginIndex({ stateDir }));
    expect(persisted.version).toBe(index.version);
    expect(persisted.warning).toContain("DO NOT EDIT.");
    expect(persisted.policyHash).toBe(index.policyHash);
    expectPluginIds(persisted, ["demo"]);
  });

  it("preserves startup config paths across persisted index roundtrips", async () => {
    const stateDir = makeTempDir();
    const index = createIndex({
      plugins: [
        {
          pluginId: "browser",
          manifestPath: "/plugins/browser/openclaw.plugin.json",
          manifestHash: "browser-manifest-hash",
          rootDir: "/plugins/browser",
          origin: "bundled",
          enabled: true,
          enabledByDefault: true,
          startup: {
            sidecar: true,
            memory: false,
            deferConfiguredChannelFullLoadUntilAfterListen: false,
            agentHarnesses: [],
            configPaths: ["browser"],
          },
          compat: ["activation-config-path-hint"],
        },
      ],
    });

    await writePersistedInstalledPluginIndex(index, { stateDir });

    const persisted = requirePersisted(await readPersistedInstalledPluginIndex({ stateDir }));
    expect(persisted.plugins[0]?.startup.configPaths).toEqual(["browser"]);
    expect(persisted.plugins[0]?.compat).toEqual(["activation-config-path-hint"]);
  });

  it("preserves contribution metadata across persisted index roundtrips", async () => {
    const stateDir = makeTempDir();
    const index = createIndex({
      plugins: [
        {
          pluginId: "provider-owner",
          manifestPath: "/plugins/provider-owner/openclaw.plugin.json",
          manifestHash: "provider-owner-manifest-hash",
          rootDir: "/plugins/provider-owner",
          origin: "bundled",
          enabled: true,
          startup: {
            sidecar: false,
            memory: false,
            deferConfiguredChannelFullLoadUntilAfterListen: false,
            agentHarnesses: [],
          },
          contributions: {
            channels: ["demo-channel"],
            channelConfigs: ["demo-channel"],
            providers: ["demo-provider"],
            modelCatalogProviders: ["demo-provider"],
            modelSupportPrefixes: ["demo-"],
            modelSupportPatterns: ["^demo-[0-9]+$"],
            autoEnableProviderIds: ["demo-auth"],
            commandAliases: ["demo-command"],
            contracts: {
              webSearchProviders: ["demo-search"],
            },
          },
          compat: [],
        },
      ],
    });

    await writePersistedInstalledPluginIndex(index, { stateDir });

    const persisted = requirePersisted(await readPersistedInstalledPluginIndex({ stateDir }));
    expect(persisted.plugins[0]?.contributions).toEqual({
      channels: ["demo-channel"],
      channelConfigs: ["demo-channel"],
      providers: ["demo-provider"],
      modelCatalogProviders: ["demo-provider"],
      modelSupportPrefixes: ["demo-"],
      modelSupportPatterns: ["^demo-[0-9]+$"],
      autoEnableProviderIds: ["demo-auth"],
      commandAliases: ["demo-command"],
      contracts: {
        webSearchProviders: ["demo-search"],
      },
    });
  });

  it("marks legacy config-path startup indexes stale so update rebuilds them", async () => {
    const stateDir = makeTempDir();
    const pluginDir = path.join(stateDir, "plugins", "demo");
    fs.mkdirSync(pluginDir, { recursive: true });
    const env = {
      OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
      OPENCLAW_VERSION: "2026.4.25",
      VITEST: "true",
    };
    const candidate = createCandidate(pluginDir, { configPaths: ["browser"] });
    const current = await refreshPersistedInstalledPluginIndex({
      reason: "manual",
      stateDir,
      candidates: [candidate],
      env,
    });
    const legacy = {
      ...current,
      plugins: current.plugins.map(dropStartupConfigPaths),
    };
    await writePersistedInstalledPluginIndex(legacy, { stateDir });

    const inspection = await inspectPersistedInstalledPluginIndex({
      stateDir,
      candidates: [candidate],
      env,
    });
    expect(inspection.state).toBe("stale");
    expect(inspection.refreshReasons).toEqual(["migration"]);

    const refreshed = await refreshPersistedInstalledPluginIndex({
      reason: "policy-changed",
      stateDir,
      candidates: [candidate],
      env,
    });
    expect(refreshed.plugins[0]?.startup.configPaths).toEqual(["browser"]);
    const persisted = requirePersisted(await readPersistedInstalledPluginIndex({ stateDir }));
    expect(persisted.plugins[0]?.startup.configPaths).toEqual(["browser"]);
  });

  it("does not preserve prototype poison keys from persisted index JSON", async () => {
    const stateDir = makeTempDir();
    const index = createIndex({
      installRecords: {
        demo: {
          source: "npm",
          spec: "demo@1.0.0",
        },
      },
    });
    Object.defineProperty(index, "__proto__", {
      enumerable: true,
      value: { polluted: true },
    });
    Object.defineProperty(index.installRecords, "__proto__", {
      enumerable: true,
      value: { polluted: true },
    });
    await writePersistedInstalledPluginIndex(index, { stateDir });

    const persisted = await readPersistedInstalledPluginIndex({ stateDir });

    const persistedIndex = requirePersisted(persisted);
    expectPluginIds(persistedIndex, ["demo"]);
    expectInstallRecord(persistedIndex, "demo", { source: "npm" });
    expect(Object.hasOwn(persisted as object, "__proto__")).toBe(false);
    expect(Object.hasOwn(persisted?.installRecords ?? {}, "__proto__")).toBe(false);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("returns null for missing or invalid persisted indexes", async () => {
    const stateDir = makeTempDir();
    await expect(readPersistedInstalledPluginIndex({ stateDir })).resolves.toBeNull();

    insertPersistedIndexRow(stateDir, { version: 999 });

    await expect(readPersistedInstalledPluginIndex({ stateDir })).resolves.toBeNull();
  });

  it("rejects pre-migration persisted indexes so update can rebuild them", async () => {
    const stateDir = makeTempDir();
    insertPersistedIndexRow(stateDir, { migrationVersion: 0 });

    await expect(readPersistedInstalledPluginIndex({ stateDir })).resolves.toBeNull();
  });

  it("inspects missing, fresh, and stale persisted index state without loading runtime", async () => {
    const stateDir = makeTempDir();
    const pluginDir = path.join(stateDir, "plugins", "demo");
    fs.mkdirSync(pluginDir, { recursive: true });
    const candidate = createCandidate(pluginDir);
    const env = {
      OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
      OPENCLAW_VERSION: "2026.4.25",
      VITEST: "true",
    };

    const missingInspect = await inspectPersistedInstalledPluginIndex({
      stateDir,
      candidates: [candidate],
      env,
    });
    expect(missingInspect.state).toBe("missing");
    expect(missingInspect.refreshReasons).toEqual(["missing"]);
    expect(missingInspect.persisted).toBeNull();
    expectPluginIds(missingInspect.current, ["demo"]);

    const current = await refreshPersistedInstalledPluginIndex({
      reason: "manual",
      stateDir,
      candidates: [candidate],
      env,
    });

    const freshInspect = await inspectPersistedInstalledPluginIndex({
      stateDir,
      candidates: [candidate],
      env,
    });
    expect(freshInspect.state).toBe("fresh");
    expect(freshInspect.refreshReasons).toEqual([]);
    expect(freshInspect.persisted).toEqual(current);
    expectPluginFields(freshInspect.current, "demo", { enabled: true });

    const policyInspect = await inspectPersistedInstalledPluginIndex({
      stateDir,
      candidates: [candidate],
      config: {
        plugins: {
          entries: {
            demo: {
              enabled: false,
            },
          },
        },
      },
      env,
    });
    expect(policyInspect.state).toBe("stale");
    expect(policyInspect.refreshReasons).toEqual(["policy-changed"]);
    expect(policyInspect.persisted).toEqual(current);
    expectPluginFields(policyInspect.current, "demo", { enabled: false });

    fs.writeFileSync(
      path.join(pluginDir, "openclaw.plugin.json"),
      JSON.stringify({
        id: "demo",
        name: "Demo",
        configSchema: { type: "object" },
        providers: ["demo", "demo-next"],
      }),
      "utf8",
    );

    const staleManifestInspect = await inspectPersistedInstalledPluginIndex({
      stateDir,
      candidates: [candidate],
      env,
    });
    expect(staleManifestInspect.state).toBe("stale");
    expect(staleManifestInspect.refreshReasons).toEqual(["stale-manifest"]);
    expect(staleManifestInspect.persisted).toEqual(current);
    expectPluginIds(staleManifestInspect.current, ["demo"]);
  });

  it("refreshes and persists a rebuilt index without loading plugin runtime", async () => {
    const stateDir = makeTempDir();
    const pluginDir = path.join(stateDir, "plugins", "demo");
    fs.mkdirSync(pluginDir, { recursive: true });
    const candidate = createCandidate(pluginDir);

    const index = await refreshPersistedInstalledPluginIndex({
      reason: "manual",
      stateDir,
      candidates: [candidate],
      env: {
        OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
        OPENCLAW_VERSION: "2026.4.25",
        VITEST: "true",
      },
    });

    expect(index.refreshReason).toBe("manual");
    expect(index.plugins.map((plugin) => plugin.pluginId)).toEqual(["demo"]);
    await expectPersistedIndex(stateDir, {
      refreshReason: "manual",
      pluginIds: ["demo"],
    });
  });

  it("refreshes policy state from the persisted registry without rebuilding source records", async () => {
    const stateDir = makeTempDir();
    const pluginDir = path.join(stateDir, "plugins", "demo");
    fs.mkdirSync(pluginDir, { recursive: true });
    const candidate = createCandidate(pluginDir);
    const env = {
      OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
      OPENCLAW_VERSION: "2026.4.25",
      VITEST: "true",
    };
    const initial = await refreshPersistedInstalledPluginIndex({
      reason: "manual",
      stateDir,
      candidates: [candidate],
      env,
    });
    fs.writeFileSync(
      path.join(pluginDir, "openclaw.plugin.json"),
      JSON.stringify({
        id: "demo",
        name: "Demo",
        configSchema: { type: "object" },
        providers: ["demo", "changed"],
      }),
      "utf8",
    );

    const refreshed = await refreshPersistedInstalledPluginIndex({
      reason: "policy-changed",
      stateDir,
      candidates: [candidate],
      env,
      config: {
        plugins: {
          entries: {
            demo: {
              enabled: false,
            },
          },
        },
      },
      policyPluginIds: ["demo"],
    });

    expect(refreshed.plugins).toHaveLength(initial.plugins.length);
    expectPluginFields(refreshed, "demo", {
      pluginId: "demo",
      enabled: false,
      manifestHash: initial.plugins[0]?.manifestHash,
    });
    expect(refreshed.policyHash).not.toBe(initial.policyHash);
  });

  it("falls back to a source rebuild when a policy refresh target is missing", async () => {
    const stateDir = makeTempDir();
    const pluginDir = path.join(stateDir, "plugins", "demo");
    const nextPluginDir = path.join(stateDir, "plugins", "next-demo");
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.mkdirSync(nextPluginDir, { recursive: true });
    const candidate = createCandidate(pluginDir);
    const nextCandidate = createCandidate(nextPluginDir, { id: "next-demo" });
    const env = {
      OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
      OPENCLAW_VERSION: "2026.4.25",
      VITEST: "true",
    };
    await refreshPersistedInstalledPluginIndex({
      reason: "manual",
      stateDir,
      candidates: [candidate],
      env,
    });

    const refreshed = await refreshPersistedInstalledPluginIndex({
      reason: "policy-changed",
      stateDir,
      candidates: [candidate, nextCandidate],
      env,
      config: {
        plugins: {
          entries: {
            "next-demo": {
              enabled: false,
            },
          },
        },
      },
      policyPluginIds: ["next-demo"],
    });

    expect(refreshed.plugins.map((plugin) => plugin.pluginId)).toContain("next-demo");
  });

  it("rebuilds policy refreshes when install records are missing from plugins", async () => {
    const stateDir = makeTempDir();
    const installPath = writeManagedNpmPlugin({
      stateDir,
      packageName: "@openclaw/whatsapp",
      pluginId: "whatsapp",
      version: "2026.5.2",
    });
    const env = {
      OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      OPENCLAW_VERSION: "2026.4.25",
      VITEST: "true",
    };
    await writePersistedInstalledPluginIndex(
      createIndex({
        installRecords: {
          whatsapp: {
            source: "npm",
            spec: "@openclaw/whatsapp@2026.5.2",
            installPath,
          },
        },
        plugins: [],
      }),
      { stateDir },
    );

    const refreshed = await refreshPersistedInstalledPluginIndex({
      reason: "policy-changed",
      stateDir,
      env,
      config: {
        plugins: {
          entries: {
            whatsapp: {
              enabled: true,
            },
          },
        },
      },
    });

    expectPluginIds(refreshed, ["whatsapp"]);
    expectPluginFields(refreshed, "whatsapp", {
      pluginId: "whatsapp",
      origin: "global",
      enabled: true,
    });
    expectInstallRecord(refreshed, "whatsapp", {
      source: "npm",
      spec: "@openclaw/whatsapp@2026.5.2",
      installPath,
    });
    await expectPersistedIndex(stateDir, {
      refreshReason: "policy-changed",
      pluginIds: ["whatsapp"],
    });
  });

  it("rebuilds policy refreshes from linked path install records", async () => {
    const stateDir = makeTempDir();
    const pluginDir = path.join(stateDir, "plugins", "local-plugin");
    fs.mkdirSync(pluginDir, { recursive: true });
    createCandidate(pluginDir, { id: "local-plugin" });
    const env = {
      OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      OPENCLAW_VERSION: "2026.4.25",
      VITEST: "true",
    };
    await writePersistedInstalledPluginIndex(
      createIndex({
        installRecords: {
          "local-plugin": {
            source: "path",
            sourcePath: pluginDir,
            installPath: pluginDir,
          },
        },
        plugins: [],
      }),
      { stateDir },
    );

    const refreshed = await refreshPersistedInstalledPluginIndex({
      reason: "policy-changed",
      stateDir,
      env,
      config: {
        plugins: {
          entries: {
            "local-plugin": {
              enabled: true,
            },
          },
        },
      },
    });

    expectPluginIds(refreshed, ["local-plugin"]);
    expectPluginFields(refreshed, "local-plugin", {
      pluginId: "local-plugin",
      origin: "global",
      enabled: true,
    });
    expectInstallRecord(refreshed, "local-plugin", {
      source: "path",
      sourcePath: pluginDir,
      installPath: pluginDir,
    });
  });

  it("keeps policy refreshes on the fast path for stale existing install paths", async () => {
    const stateDir = makeTempDir();
    const staleDir = path.join(stateDir, "plugins", "stale");
    const bundledDir = path.join(stateDir, "bundled");
    const bundledPluginDir = path.join(bundledDir, "bundled-demo");
    fs.mkdirSync(staleDir, { recursive: true });
    fs.mkdirSync(bundledPluginDir, { recursive: true });
    createCandidate(bundledPluginDir, { id: "bundled-demo" });
    const installRecord = {
      source: "path" as const,
      sourcePath: staleDir,
      installPath: staleDir,
    };
    const env = {
      OPENCLAW_BUNDLED_PLUGINS_DIR: bundledDir,
      OPENCLAW_VERSION: "2026.4.25",
      VITEST: "true",
    };
    const baseline = await refreshPersistedInstalledPluginIndex({
      reason: "manual",
      stateDir,
      candidates: [],
      env,
    });
    await writePersistedInstalledPluginIndex(
      {
        ...baseline,
        installRecords: {
          stale: installRecord,
        },
        plugins: [],
      },
      { stateDir },
    );

    const refreshed = await refreshPersistedInstalledPluginIndex({
      reason: "policy-changed",
      stateDir,
      env,
    });

    expectPluginIds(refreshed, []);
    expectInstallRecord(refreshed, "stale", installRecord);
    await expectPersistedIndex(stateDir, {
      refreshReason: "policy-changed",
      pluginIds: [],
      installRecords: {
        stale: installRecord,
      },
    });
  });

  it("rebuilds policy refreshes for pathless install records missing from the index", async () => {
    const stateDir = makeTempDir();
    const pluginDir = path.join(stateDir, "plugins", "pathless");
    fs.mkdirSync(pluginDir, { recursive: true });
    const candidate = createCandidate(pluginDir, { id: "pathless-demo" });
    const installRecord = {
      source: "npm" as const,
      spec: "pathless-demo@1.0.0",
    };
    const env = {
      OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
      OPENCLAW_VERSION: "2026.4.25",
      VITEST: "true",
    };
    const baseline = await refreshPersistedInstalledPluginIndex({
      reason: "manual",
      stateDir,
      candidates: [],
      env,
    });
    await writePersistedInstalledPluginIndex(
      {
        ...baseline,
        installRecords: {
          "pathless-demo": installRecord,
        },
        plugins: [],
      },
      { stateDir },
    );

    const refreshed = await refreshPersistedInstalledPluginIndex({
      reason: "policy-changed",
      stateDir,
      candidates: [candidate],
      env,
    });

    expectPluginIds(refreshed, ["pathless-demo"]);
    expectInstallRecord(refreshed, "pathless-demo", installRecord);
    await expectPersistedIndex(stateDir, {
      refreshReason: "policy-changed",
      pluginIds: ["pathless-demo"],
      installRecords: {
        "pathless-demo": installRecord,
      },
    });
  });

  it("rebuilds policy refreshes when explicit candidates can recover a missing plugin", async () => {
    const stateDir = makeTempDir();
    const staleDir = path.join(stateDir, "plugins", "stale-explicit");
    const candidateDir = path.join(stateDir, "candidates", "explicit-recovered");
    fs.mkdirSync(staleDir, { recursive: true });
    fs.mkdirSync(candidateDir, { recursive: true });
    const candidate = createCandidate(candidateDir, { id: "explicit-recovered" });
    const installRecord = {
      source: "path" as const,
      sourcePath: staleDir,
      installPath: staleDir,
    };
    const env = {
      OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      OPENCLAW_VERSION: "2026.4.25",
      VITEST: "true",
    };
    const baseline = await refreshPersistedInstalledPluginIndex({
      reason: "manual",
      stateDir,
      candidates: [],
      env,
    });
    await writePersistedInstalledPluginIndex(
      {
        ...baseline,
        installRecords: {
          "explicit-recovered": installRecord,
        },
        plugins: [],
      },
      { stateDir },
    );

    const refreshed = await refreshPersistedInstalledPluginIndex({
      reason: "policy-changed",
      stateDir,
      candidates: [candidate],
      env,
    });

    expectPluginIds(refreshed, ["explicit-recovered"]);
    expectInstallRecord(refreshed, "explicit-recovered", installRecord);
    await expectPersistedIndex(stateDir, {
      refreshReason: "policy-changed",
      pluginIds: ["explicit-recovered"],
      installRecords: {
        "explicit-recovered": installRecord,
      },
    });
  });

  it("rebuilds policy refreshes when supplied discovery can recover a missing plugin", async () => {
    const stateDir = makeTempDir();
    const staleDir = path.join(stateDir, "plugins", "stale-discovery");
    const candidateDir = path.join(stateDir, "candidates", "discovery-recovered");
    fs.mkdirSync(staleDir, { recursive: true });
    fs.mkdirSync(candidateDir, { recursive: true });
    const candidate = createCandidate(candidateDir, { id: "discovery-recovered" });
    const installRecord = {
      source: "path" as const,
      sourcePath: staleDir,
      installPath: staleDir,
    };
    const env = {
      OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      OPENCLAW_VERSION: "2026.4.25",
      VITEST: "true",
    };
    const baseline = await refreshPersistedInstalledPluginIndex({
      reason: "manual",
      stateDir,
      candidates: [],
      env,
    });
    await writePersistedInstalledPluginIndex(
      {
        ...baseline,
        installRecords: {
          "discovery-recovered": installRecord,
        },
        plugins: [],
      },
      { stateDir },
    );

    const refreshed = await refreshPersistedInstalledPluginIndex({
      reason: "policy-changed",
      stateDir,
      discovery: { candidates: [candidate], diagnostics: [] },
      env,
    });

    expectPluginIds(refreshed, ["discovery-recovered"]);
    expectInstallRecord(refreshed, "discovery-recovered", installRecord);
    await expectPersistedIndex(stateDir, {
      refreshReason: "policy-changed",
      pluginIds: ["discovery-recovered"],
      installRecords: {
        "discovery-recovered": installRecord,
      },
    });
  });

  it("keeps unrelated explicit recovery candidates on the policy refresh fast path", async () => {
    const stateDir = makeTempDir();
    const staleDir = path.join(stateDir, "plugins", "stale-unrelated");
    const candidateDir = path.join(stateDir, "candidates", "unrelated");
    fs.mkdirSync(staleDir, { recursive: true });
    fs.mkdirSync(candidateDir, { recursive: true });
    const candidate = createCandidate(candidateDir, { id: "unrelated" });
    const installRecord = {
      source: "path" as const,
      sourcePath: staleDir,
      installPath: staleDir,
    };
    const env = {
      OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      OPENCLAW_VERSION: "2026.4.25",
      VITEST: "true",
    };
    const baseline = await refreshPersistedInstalledPluginIndex({
      reason: "manual",
      stateDir,
      candidates: [],
      env,
    });
    await writePersistedInstalledPluginIndex(
      {
        ...baseline,
        installRecords: {
          stale: installRecord,
        },
        plugins: [],
      },
      { stateDir },
    );

    const refreshed = await refreshPersistedInstalledPluginIndex({
      reason: "policy-changed",
      stateDir,
      candidates: [candidate],
      env,
    });

    expectPluginIds(refreshed, []);
    expectInstallRecord(refreshed, "stale", installRecord);
    await expectPersistedIndex(stateDir, {
      refreshReason: "policy-changed",
      pluginIds: [],
      installRecords: {
        stale: installRecord,
      },
    });
  });

  it("rebuilds policy refreshes when a stale install path has a discoverable source path", async () => {
    const stateDir = makeTempDir();
    const staleDir = path.join(stateDir, "plugins", "stale-install");
    const sourceDir = path.join(stateDir, "extensions", "source-recovered");
    fs.mkdirSync(staleDir, { recursive: true });
    fs.mkdirSync(sourceDir, { recursive: true });
    createCandidate(sourceDir, { id: "source-recovered" });
    const installRecord = {
      source: "path" as const,
      sourcePath: sourceDir,
      installPath: staleDir,
    };
    const env = {
      OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_VERSION: "2026.4.25",
      VITEST: "true",
    };
    const baseline = await refreshPersistedInstalledPluginIndex({
      reason: "manual",
      stateDir,
      candidates: [],
      env,
    });
    await writePersistedInstalledPluginIndex(
      {
        ...baseline,
        installRecords: {
          "source-recovered": installRecord,
        },
        plugins: [],
      },
      { stateDir },
    );

    const refreshed = await refreshPersistedInstalledPluginIndex({
      reason: "policy-changed",
      stateDir,
      env,
    });

    expectPluginIds(refreshed, ["source-recovered"]);
    expectInstallRecord(refreshed, "source-recovered", installRecord);
    await expectPersistedIndex(stateDir, {
      refreshReason: "policy-changed",
      pluginIds: ["source-recovered"],
      installRecords: {
        "source-recovered": installRecord,
      },
    });
  });

  it("keeps unreachable source paths on the policy refresh fast path", async () => {
    const stateDir = makeTempDir();
    const staleDir = path.join(stateDir, "plugins", "stale-unreachable-source");
    const sourceDir = path.join(stateDir, "outside-source");
    fs.mkdirSync(staleDir, { recursive: true });
    fs.mkdirSync(sourceDir, { recursive: true });
    createCandidate(sourceDir, { id: "outside-source" });
    const installRecord = {
      source: "path" as const,
      sourcePath: sourceDir,
      installPath: staleDir,
    };
    const env = {
      OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_VERSION: "2026.4.25",
      VITEST: "true",
    };
    const baseline = await refreshPersistedInstalledPluginIndex({
      reason: "manual",
      stateDir,
      candidates: [],
      env,
    });
    await writePersistedInstalledPluginIndex(
      {
        ...baseline,
        installRecords: {
          "outside-source": installRecord,
        },
        plugins: [],
      },
      { stateDir },
    );

    const refreshed = await refreshPersistedInstalledPluginIndex({
      reason: "policy-changed",
      stateDir,
      env,
    });

    expectPluginIds(refreshed, []);
    expectInstallRecord(refreshed, "outside-source", installRecord);
    await expectPersistedIndex(stateDir, {
      refreshReason: "policy-changed",
      pluginIds: [],
      installRecords: {
        "outside-source": installRecord,
      },
    });
  });

  it("rebuilds policy refreshes for config-loaded source path plugins", async () => {
    const stateDir = makeTempDir();
    const staleDir = path.join(stateDir, "plugins", "stale-config-install");
    const sourceDir = path.join(stateDir, "workspace-plugin");
    fs.mkdirSync(staleDir, { recursive: true });
    fs.mkdirSync(path.join(sourceDir, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(sourceDir, "package.json"),
      JSON.stringify({
        name: "config-source",
        openclaw: {
          extensions: ["./src/index.ts"],
        },
      }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(sourceDir, "openclaw.plugin.json"),
      JSON.stringify({
        id: "config-source",
        name: "Config Source",
        configSchema: { type: "object" },
        providers: ["config-source"],
      }),
      "utf8",
    );
    fs.writeFileSync(path.join(sourceDir, "src", "index.ts"), "export default {};\n", "utf8");
    const installRecord = {
      source: "path" as const,
      sourcePath: sourceDir,
      installPath: staleDir,
    };
    const config = {
      plugins: {
        load: { paths: [sourceDir] },
      },
    };
    const env = {
      OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_VERSION: "2026.4.25",
      VITEST: "true",
    };
    const baseline = await refreshPersistedInstalledPluginIndex({
      reason: "manual",
      stateDir,
      candidates: [],
      config,
      env,
    });
    await writePersistedInstalledPluginIndex(
      {
        ...baseline,
        installRecords: {
          "config-source": installRecord,
        },
        plugins: [],
      },
      { stateDir },
    );

    const refreshed = await refreshPersistedInstalledPluginIndex({
      reason: "policy-changed",
      stateDir,
      config,
      env,
    });

    expectPluginIds(refreshed, ["config-source"]);
    expectInstallRecord(refreshed, "config-source", installRecord);
    await expectPersistedIndex(stateDir, {
      refreshReason: "policy-changed",
      pluginIds: ["config-source"],
      installRecords: {
        "config-source": installRecord,
      },
    });
  });

  it("rebuilds policy refreshes when config load paths can recover a missing plugin", async () => {
    const stateDir = makeTempDir();
    const staleDir = path.join(stateDir, "plugins", "stale-config-candidate");
    const configDir = path.join(stateDir, "configured", "config-recovered");
    fs.mkdirSync(staleDir, { recursive: true });
    fs.mkdirSync(configDir, { recursive: true });
    createCandidate(configDir, { id: "config-recovered" });
    const installRecord = {
      source: "path" as const,
      sourcePath: staleDir,
      installPath: staleDir,
    };
    const config = {
      plugins: {
        load: { paths: [configDir] },
      },
    };
    const env = {
      OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_VERSION: "2026.4.25",
      VITEST: "true",
    };
    const baseline = await refreshPersistedInstalledPluginIndex({
      reason: "manual",
      stateDir,
      candidates: [],
      config,
      env,
    });
    await writePersistedInstalledPluginIndex(
      {
        ...baseline,
        installRecords: {
          "config-recovered": installRecord,
        },
        plugins: [],
      },
      { stateDir },
    );

    const refreshed = await refreshPersistedInstalledPluginIndex({
      reason: "policy-changed",
      stateDir,
      config,
      env,
    });

    expectPluginIds(refreshed, ["config-recovered"]);
    expectInstallRecord(refreshed, "config-recovered", installRecord);
    await expectPersistedIndex(stateDir, {
      refreshReason: "policy-changed",
      pluginIds: ["config-recovered"],
      installRecords: {
        "config-recovered": installRecord,
      },
    });
  });

  it("keeps unconfigured source path plugins on the policy refresh fast path", async () => {
    const stateDir = makeTempDir();
    const staleDir = path.join(stateDir, "plugins", "stale-unconfigured-install");
    const sourceDir = path.join(stateDir, "unconfigured-source");
    fs.mkdirSync(staleDir, { recursive: true });
    fs.mkdirSync(path.join(sourceDir, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(sourceDir, "package.json"),
      JSON.stringify({
        name: "unconfigured-source",
        openclaw: {
          extensions: ["./src/index.ts"],
        },
      }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(sourceDir, "openclaw.plugin.json"),
      JSON.stringify({
        id: "unconfigured-source",
        name: "Unconfigured Source",
        configSchema: { type: "object" },
        providers: ["unconfigured-source"],
      }),
      "utf8",
    );
    fs.writeFileSync(path.join(sourceDir, "src", "index.ts"), "export default {};\n", "utf8");
    const installRecord = {
      source: "path" as const,
      sourcePath: sourceDir,
      installPath: staleDir,
    };
    const env = {
      OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_VERSION: "2026.4.25",
      VITEST: "true",
    };
    const baseline = await refreshPersistedInstalledPluginIndex({
      reason: "manual",
      stateDir,
      candidates: [],
      env,
    });
    await writePersistedInstalledPluginIndex(
      {
        ...baseline,
        installRecords: {
          "unconfigured-source": installRecord,
        },
        plugins: [],
      },
      { stateDir },
    );

    const refreshed = await refreshPersistedInstalledPluginIndex({
      reason: "policy-changed",
      stateDir,
      env,
    });

    expectPluginIds(refreshed, []);
    expectInstallRecord(refreshed, "unconfigured-source", installRecord);
    await expectPersistedIndex(stateDir, {
      refreshReason: "policy-changed",
      pluginIds: [],
      installRecords: {
        "unconfigured-source": installRecord,
      },
    });
  });

  it("ignores malformed config load paths while checking missing install recovery", async () => {
    const stateDir = makeTempDir();
    const staleDir = path.join(stateDir, "plugins", "stale-malformed-config-install");
    const sourceDir = path.join(stateDir, "malformed-config-source");
    fs.mkdirSync(staleDir, { recursive: true });
    fs.mkdirSync(path.join(sourceDir, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(sourceDir, "package.json"),
      JSON.stringify({
        name: "malformed-config-source",
        openclaw: {
          extensions: ["./src/index.ts"],
        },
      }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(sourceDir, "openclaw.plugin.json"),
      JSON.stringify({
        id: "malformed-config-source",
        name: "Malformed Config Source",
        configSchema: { type: "object" },
        providers: ["malformed-config-source"],
      }),
      "utf8",
    );
    fs.writeFileSync(path.join(sourceDir, "src", "index.ts"), "export default {};\n", "utf8");
    const installRecord = {
      source: "path" as const,
      sourcePath: sourceDir,
      installPath: staleDir,
    };
    const config = {
      plugins: {
        load: {
          paths: { bad: sourceDir } as unknown as string[],
        },
      },
    };
    const env = {
      OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_VERSION: "2026.4.25",
      VITEST: "true",
    };
    const baseline = await refreshPersistedInstalledPluginIndex({
      reason: "manual",
      stateDir,
      candidates: [],
      config,
      env,
    });
    await writePersistedInstalledPluginIndex(
      {
        ...baseline,
        installRecords: {
          "malformed-config-source": installRecord,
        },
        plugins: [],
      },
      { stateDir },
    );

    const refreshed = await refreshPersistedInstalledPluginIndex({
      reason: "policy-changed",
      stateDir,
      config,
      env,
    });

    expectPluginIds(refreshed, []);
    expectInstallRecord(refreshed, "malformed-config-source", installRecord);
    await expectPersistedIndex(stateDir, {
      refreshReason: "policy-changed",
      pluginIds: [],
      installRecords: {
        "malformed-config-source": installRecord,
      },
    });
  });

  it("rebuilds policy refreshes for config-loaded source plugin files", async () => {
    const stateDir = makeTempDir();
    const staleDir = path.join(stateDir, "plugins", "stale-config-file-install");
    const sourceDir = path.join(stateDir, "file-config-source");
    const sourceFile = path.join(sourceDir, "index.ts");
    fs.mkdirSync(staleDir, { recursive: true });
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.writeFileSync(sourceFile, "export default {};\n", "utf8");
    fs.writeFileSync(
      path.join(sourceDir, "openclaw.plugin.json"),
      JSON.stringify({
        id: "file-config-source",
        name: "File Config Source",
        configSchema: { type: "object" },
        providers: ["file-config-source"],
      }),
      "utf8",
    );
    const installRecord = {
      source: "path" as const,
      sourcePath: sourceDir,
      installPath: staleDir,
    };
    const config = {
      plugins: {
        load: { paths: [sourceFile] },
      },
    };
    const env = {
      OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_VERSION: "2026.4.25",
      VITEST: "true",
    };
    const baseline = await refreshPersistedInstalledPluginIndex({
      reason: "manual",
      stateDir,
      candidates: [],
      config,
      env,
    });
    await writePersistedInstalledPluginIndex(
      {
        ...baseline,
        installRecords: {
          "file-config-source": installRecord,
        },
        plugins: [],
      },
      { stateDir },
    );

    const refreshed = await refreshPersistedInstalledPluginIndex({
      reason: "policy-changed",
      stateDir,
      config,
      env,
    });

    expectPluginIds(refreshed, ["file-config-source"]);
    expectInstallRecord(refreshed, "file-config-source", installRecord);
    await expectPersistedIndex(stateDir, {
      refreshReason: "policy-changed",
      pluginIds: ["file-config-source"],
      installRecords: {
        "file-config-source": installRecord,
      },
    });
  });

  it("keeps policy refreshes on the fast path for source-only npm install records", async () => {
    const stateDir = makeTempDir();
    const sourceOnlyDir = path.join(stateDir, "plugins", "source-only");
    const bundledDir = path.join(stateDir, "bundled");
    const bundledPluginDir = path.join(bundledDir, "bundled-demo");
    fs.mkdirSync(path.join(sourceOnlyDir, "src"), { recursive: true });
    fs.mkdirSync(bundledPluginDir, { recursive: true });
    createCandidate(bundledPluginDir, { id: "bundled-demo" });
    fs.writeFileSync(
      path.join(sourceOnlyDir, "package.json"),
      JSON.stringify({
        name: "@openclaw/source-only",
        openclaw: {
          extensions: ["./src/index.ts"],
        },
      }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(sourceOnlyDir, "openclaw.plugin.json"),
      JSON.stringify({
        id: "source-only",
        name: "Source Only",
        configSchema: { type: "object" },
        providers: ["source-only"],
      }),
      "utf8",
    );
    fs.writeFileSync(path.join(sourceOnlyDir, "src", "index.ts"), "export default {};\n", "utf8");
    const installRecord = {
      source: "npm" as const,
      spec: "@openclaw/source-only@1.0.0",
      installPath: sourceOnlyDir,
    };
    const env = {
      OPENCLAW_BUNDLED_PLUGINS_DIR: bundledDir,
      OPENCLAW_VERSION: "2026.4.25",
      VITEST: "true",
    };
    const baseline = await refreshPersistedInstalledPluginIndex({
      reason: "manual",
      stateDir,
      candidates: [],
      env,
    });
    await writePersistedInstalledPluginIndex(
      {
        ...baseline,
        installRecords: {
          "source-only": installRecord,
        },
        plugins: [],
      },
      { stateDir },
    );

    const refreshed = await refreshPersistedInstalledPluginIndex({
      reason: "policy-changed",
      stateDir,
      env,
    });

    expectPluginIds(refreshed, []);
    expectInstallRecord(refreshed, "source-only", installRecord);
    await expectPersistedIndex(stateDir, {
      refreshReason: "policy-changed",
      pluginIds: [],
      installRecords: {
        "source-only": installRecord,
      },
    });
  });

  it("preserves existing install records when refreshing the manifest cache", async () => {
    const stateDir = makeTempDir();
    await writePersistedInstalledPluginIndex(
      createIndex({
        installRecords: {
          missing: {
            source: "npm",
            spec: "missing-plugin@1.0.0",
            installPath: path.join(stateDir, "plugins", "missing"),
          },
        },
        plugins: [],
      }),
      { stateDir },
    );

    const index = await refreshPersistedInstalledPluginIndex({
      reason: "manual",
      stateDir,
      candidates: [],
      env: {
        OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
        OPENCLAW_VERSION: "2026.4.25",
        VITEST: "true",
      },
    });

    expectInstallRecord(index, "missing", {
      source: "npm",
      spec: "missing-plugin@1.0.0",
      installPath: path.join(stateDir, "plugins", "missing"),
    });
    expectPluginIds(index, []);
    await expectPersistedIndex(stateDir, {
      pluginIds: [],
      installRecords: {
        missing: {
          source: "npm",
          spec: "missing-plugin@1.0.0",
          installPath: path.join(stateDir, "plugins", "missing"),
        },
      },
    });
  });

  it("preserves ClawHub ClawPack source facts when refreshing the manifest cache", async () => {
    const stateDir = makeTempDir();
    const installPath = path.join(stateDir, "plugins", "clawpack-demo");
    await writePersistedInstalledPluginIndex(
      createIndex({
        installRecords: {
          "clawpack-demo": {
            source: "clawhub",
            spec: "clawhub:clawpack-demo@2026.5.1-beta.2",
            installPath,
            version: "2026.5.1-beta.2",
            integrity: "sha256-archive",
            resolvedAt: "2026-05-01T00:00:00.000Z",
            clawhubUrl: "https://clawhub.ai",
            clawhubPackage: "clawpack-demo",
            clawhubFamily: "code-plugin",
            clawhubChannel: "official",
            artifactKind: "npm-pack",
            artifactFormat: "tgz",
            npmIntegrity: "sha512-clawpack",
            npmShasum: "1".repeat(40),
            npmTarballName: "clawpack-demo-2026.5.1-beta.2.tgz",
            clawpackSha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            clawpackSpecVersion: 1,
            clawpackManifestSha256:
              "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            clawpackSize: 4096,
          },
        },
        plugins: [],
      }),
      { stateDir },
    );

    const index = await refreshPersistedInstalledPluginIndex({
      reason: "manual",
      stateDir,
      candidates: [],
      env: {
        OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
        OPENCLAW_VERSION: "2026.4.25",
        VITEST: "true",
      },
    });

    const expectedRecord = {
      source: "clawhub",
      spec: "clawhub:clawpack-demo@2026.5.1-beta.2",
      installPath,
      version: "2026.5.1-beta.2",
      integrity: "sha256-archive",
      resolvedAt: "2026-05-01T00:00:00.000Z",
      clawhubUrl: "https://clawhub.ai",
      clawhubPackage: "clawpack-demo",
      clawhubFamily: "code-plugin",
      clawhubChannel: "official",
      artifactKind: "npm-pack",
      artifactFormat: "tgz",
      npmIntegrity: "sha512-clawpack",
      npmShasum: "1".repeat(40),
      npmTarballName: "clawpack-demo-2026.5.1-beta.2.tgz",
      clawpackSha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      clawpackSpecVersion: 1,
      clawpackManifestSha256: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      clawpackSize: 4096,
    };
    expectInstallRecord(index, "clawpack-demo", expectedRecord);
    expectPluginIds(index, []);
    await expectPersistedIndex(stateDir, {
      pluginIds: [],
      installRecords: {
        "clawpack-demo": expectedRecord,
      },
    });
  });
});

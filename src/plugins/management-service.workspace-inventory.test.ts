import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { resolveConfigWidePluginMetadataSnapshot as resolveMetadata } from "../config/io.plugin-metadata.js";
import type { ConfigReplaceInput } from "../config/mutate.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import { setGatewayPluginMetadataSnapshot as setMetadata } from "./current-plugin-metadata-snapshot.js";
import { getGatewayPluginMetadataSnapshot as currentMetadata } from "./current-plugin-metadata-state.js";
import { resolvePluginInstallDir } from "./install-paths.js";
import { persistPluginInstall } from "./install-persistence.js";
import { writePersistedInstalledPluginIndex as writeIndex } from "./installed-plugin-index-store-write.js";
import { readPersistedInstalledPluginIndex as readIndex } from "./installed-plugin-index-store.js";
import { loadInstalledPluginIndex as loadIndex } from "./installed-plugin-index.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";
import { loadPluginMetadataSnapshot as loadMetadata } from "./plugin-metadata-snapshot.js";
import * as metadataWorker from "./plugin-metadata-state-worker.js";
import { createColdPluginFixture } from "./test-helpers/cold-plugin-fixtures.js";
import {
  cleanupTrackedTempDirs,
  makeTrackedTempDir,
  mkdirSafeDir,
} from "./test-helpers/fs-fixtures.js";

const configIo = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn() }));

vi.mock("../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/config.js")>()),
  readConfigFileSnapshotForWrite: () => configIo.read(),
  replaceConfigFile: (params: unknown) => configIo.write(params),
}));

vi.mock("./official-external-plugin-catalog.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./official-external-plugin-catalog.js")>()),
  loadConfiguredHostedOfficialExternalPluginCatalogEntries: async () => ({
    source: "hosted",
    entries: [],
  }),
}));

const { listManagedPlugins, refreshManagedPluginMetadata } =
  await import("./management-service.js");
const { mutateManagedPluginEnabled, setManagedPluginEnabled } =
  await import("./management-mutations.js");
const { uninstallManagedPlugin } = await import("./management-uninstall.js");
const roots: string[] = [];

beforeEach(() => {
  clearPluginMetadataLifecycleCaches();
});

afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
  cleanupTrackedTempDirs(roots);
  vi.unstubAllEnvs();
});

function isolateWorkspace(root: string, configPath?: string) {
  vi.stubEnv("OPENCLAW_HOME", path.join(root, "home"));
  vi.stubEnv("OPENCLAW_STATE_DIR", path.join(root, "state"));
  vi.stubEnv("OPENCLAW_DISABLE_BUNDLED_PLUGINS", "1");
  if (configPath) {
    vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
  }
}

function workspace(
  name: string,
  options: { kind?: string; capabilities?: boolean; installed?: boolean } = {},
) {
  const root = makeTrackedTempDir(`managed-${name}`, roots);
  const pluginRoot = options.installed
    ? resolvePluginInstallDir(name, path.join(root, "state", "extensions"))
    : path.join(root, "plugin");
  const configPath = path.join(root, "openclaw.json");
  const fixture = coldFixture(pluginRoot, name, options);
  isolateWorkspace(root, configPath);
  return { root, pluginRoot, configPath, fixture };
}

function pluginConfig(pluginRoot: string, pluginId: string, enabled: boolean): OpenClawConfig {
  return { plugins: { load: { paths: [pluginRoot] }, entries: { [pluginId]: { enabled } } } };
}

const pathInstall = (pluginRoot: string) => ({
  source: "path" as const,
  sourcePath: pluginRoot,
  installPath: pluginRoot,
});
const inventory = async (config: OpenClawConfig) => (await listManagedPlugins({ config })).plugins;
const listedPlugin = (id: string, fields = {}) => expect.objectContaining({ id, ...fields });

async function persistIndex(
  config: OpenClawConfig,
  installRecords: NonNullable<Parameters<typeof loadIndex>[0]>["installRecords"],
) {
  await writeIndex(loadIndex({ config, env: process.env, installRecords }));
}

async function useRealConfigFile(configPath: string, config: OpenClawConfig) {
  const raw = JSON.stringify(config);
  fs.writeFileSync(configPath, raw);
  const actual = await vi.importActual<typeof import("../config/config.js")>("../config/config.js");
  configIo.read.mockImplementation(actual.readConfigFileSnapshotForWrite);
  configIo.write.mockImplementation(actual.replaceConfigFile);
  return { raw, actual };
}

function publishMetadata(config: OpenClawConfig) {
  const boot = resolveMetadata({
    config,
    env: process.env,
    allowCurrent: false,
  });
  setMetadata(boot, { config, env: process.env });
  return boot;
}

function coldFixture(
  rootDir: string,
  pluginId: string,
  { kind, capabilities }: { kind?: string; capabilities?: boolean } = {},
) {
  mkdirSafeDir(rootDir);
  return createColdPluginFixture({
    rootDir,
    pluginId,
    manifest: {
      ...(kind ? { kind } : {}),
      ...(!capabilities && {
        providers: [],
        channels: [],
        channelConfigs: {},
        providerAuthChoices: [],
      }),
    },
  });
}

function mockConfigFile(
  configPath: string,
  initial: OpenClawConfig,
  options: { error?: Error; receipt?: boolean } = {},
) {
  let current = initial;
  configIo.read.mockImplementation(async () => ({
    snapshot: {
      valid: true,
      parsed: current,
      sourceConfig: current,
      path: configPath,
      hash: "base-hash",
    },
    writeOptions: { expectedConfigPath: configPath },
  }));
  configIo.write.mockImplementation(async (params: ConfigReplaceInput) => {
    if (options.error) {
      throw options.error;
    }
    const config = params.sourceConfig ?? params.nextConfig;
    current = config;
    fs.writeFileSync(configPath, JSON.stringify(config));
    return {
      path: configPath,
      nextConfig: config,
      ...(options.receipt && { persistedHash: "committed", persistedSourceConfig: config }),
    };
  });
  return () => current;
}

it("refreshes foreign install facts and requires live authority before publishing management inventory", async () => {
  const {
    root,
    pluginRoot,
    fixture: { pluginId: id },
  } = workspace("external-candidate", { capabilities: true });
  const loadPath = path.join(root, "configured-plugins");
  mkdirSafeDir(loadPath);
  const config: OpenClawConfig = { plugins: { load: { paths: [loadPath] } } };
  await writeIndex(loadIndex({ config, env: process.env, candidates: [], installRecords: {} }));
  const boot = publishMetadata(config);
  expect(await inventory(config)).not.toContainEqual(listedPlugin(id));

  // Simulate a separate CLI process committing without this process's cache notifications.
  runOpenClawStateWriteTransaction(({ db }) => {
    db.prepare(
      "UPDATE config_machine_state SET value_json = json_set(value_json, '$.index.installRecords', json(?)) WHERE state_key = 'plugins.installedIndex'",
    ).run(JSON.stringify({ [id]: pathInstall(pluginRoot) }));
  });

  let current = true;
  const prepareMetadata = metadataWorker.readPluginMetadataStateRow;
  const preparation = vi
    .spyOn(metadataWorker, "readPluginMetadataStateRow")
    .mockImplementationOnce(async (...params) => {
      const snapshot = await prepareMetadata(...params);
      current = false;
      return snapshot;
    });
  try {
    await expect(
      refreshManagedPluginMetadata({
        config,
        assertCurrent() {
          if (!current) {
            throw new Error("Plugin management authority was revoked after preparation");
          }
        },
      }),
    ).rejects.toThrow("Plugin management authority was revoked after preparation");
    expect(await inventory(config)).not.toContainEqual(listedPlugin(id));
    expect(currentMetadata()).toBe(boot);
  } finally {
    preparation.mockRestore();
  }

  const sql = observeMainThreadSql();
  try {
    await refreshManagedPluginMetadata({ config });
    sql.expectIdle();
  } finally {
    sql.restore();
  }

  expect(await inventory(config)).toContainEqual(listedPlugin(id, { installed: true }));
  expect(currentMetadata()).toBe(boot);
  expect(boot.byPluginId.has(id)).toBe(false);
});

it("removes an npm-pack plugin from management inventory without replacing Gateway metadata", async () => {
  const {
    root,
    pluginRoot,
    configPath,
    fixture: { pluginId: id },
  } = workspace("tgz-visible", { installed: true, capabilities: true });
  const config: OpenClawConfig = {
    plugins: { entries: { [id]: { enabled: true } } },
  };
  const installRecord = {
    source: "npm",
    spec: "@example/openclaw-cold-control-plane@1.0.0",
    sourcePath: path.join(root, `${id}.tgz`),
    installPath: pluginRoot,
    artifactKind: "npm-pack",
    artifactFormat: "tgz",
  } as const;
  const currentConfig = mockConfigFile(configPath, config);
  await persistIndex(config, { [id]: installRecord });
  const boot = loadMetadata({
    config,
    env: process.env,
    preferPersisted: false,
  });
  setMetadata(boot, { config, env: process.env });
  expect(await inventory(config)).toContainEqual(listedPlugin(id, { installed: true }));

  await uninstallManagedPlugin({ pluginId: id });

  expect(fs.existsSync(pluginRoot)).toBe(false);
  expect((await readIndex())?.plugins.some((plugin) => plugin.pluginId === id)).toBe(false);
  expect(await inventory(currentConfig())).not.toContainEqual(listedPlugin(id));
  expect(currentMetadata()).toBe(boot);
  expect(boot.byPluginId.has(id)).toBe(true);
});

it("toggles a listed secondary-workspace plugin without a system owner", async () => {
  const root = makeTrackedTempDir("managed-workspace-inventory", roots);
  const mainWorkspace = path.join(root, "main");
  const secondaryWorkspace = path.join(root, "secondary");
  const pluginRoot = path.join(secondaryWorkspace, ".openclaw", "extensions", "workspace-memory");
  const { pluginId: id } = coldFixture(pluginRoot, "workspace-memory", { kind: "memory" });
  isolateWorkspace(root);
  const config: OpenClawConfig = {
    agents: {
      ownership: "explicit",
      entries: {
        main: { workspace: mainWorkspace },
        secondary: { workspace: secondaryWorkspace },
      },
    },
    plugins: { entries: { [id]: { enabled: false } } },
  };
  const currentConfig = mockConfigFile(path.join(root, "openclaw.json"), config);
  const boot = publishMetadata(config);
  expect(await inventory(config)).toContainEqual(
    listedPlugin(id, { installed: true, enabled: false }),
  );

  for (const enabled of [true, false]) {
    const result = await setManagedPluginEnabled({ pluginId: id, enabled });
    expect(result.plugin).toMatchObject({ id, installed: true, enabled });
    expect(currentConfig().plugins?.entries?.[id]?.enabled).toBe(enabled);
    if (enabled) {
      expect(currentConfig().plugins?.slots?.memory).toBe(id);
    }
    expect(currentMetadata()).toBe(boot);
    expect(boot.index.plugins.find((plugin) => plugin.pluginId === id)?.enabled).toBe(false);
  }
});

it.each([true, false])("keeps config bytes for repeated enabled=%s requests", async (enabled) => {
  const { pluginRoot, configPath, fixture } = workspace("policy-noop", { capabilities: true });
  const config = pluginConfig(pluginRoot, fixture.pluginId, enabled);
  const { raw } = await useRealConfigFile(configPath, config);

  const result = await mutateManagedPluginEnabled({
    caller: "cli",
    pluginId: fixture.pluginId,
    enabled,
  });

  expect(result).toMatchObject({ status: "committed", changedPaths: [] });
  expect(fs.readFileSync(configPath, "utf8")).toBe(raw);
});

it("preserves env references across management capability consent", async () => {
  const { pluginRoot, configPath, fixture } = workspace("consent-env");
  fs.writeFileSync(fixture.runtimeSource, 'module.exports = { id: "consent-env", register() {} };');
  vi.stubEnv("OPENCLAW_TEST_CONSENT_PREFIX", "before-consent");
  const config: OpenClawConfig = {
    messages: { responsePrefix: "${OPENCLAW_TEST_CONSENT_PREFIX}" },
    ...pluginConfig(pluginRoot, fixture.pluginId, false),
  };
  const { raw, actual } = await useRealConfigFile(configPath, config);
  await persistIndex(config, { [fixture.pluginId]: pathInstall(pluginRoot) });
  let consentCalls = 0;
  const result = await mutateManagedPluginEnabled({
    caller: "management",
    pluginId: fixture.pluginId,
    enabled: true,
    onCapabilityConsent: async (review) => {
      consentCalls += 1;
      await Promise.resolve();
      vi.stubEnv("OPENCLAW_TEST_CONSENT_PREFIX", "after-consent");
      expect(fs.readFileSync(configPath, "utf8")).toBe(raw);
      return { reviewToken: review.reviewToken };
    },
  });
  expect(consentCalls).toBe(1);
  expect(result.status).toBe("committed");
  expect(JSON.parse(fs.readFileSync(configPath, "utf8"))).toMatchObject({
    messages: { responsePrefix: "${OPENCLAW_TEST_CONSENT_PREFIX}" },
    plugins: { entries: { [fixture.pluginId]: { enabled: true } } },
  });
  const fresh = await actual.readConfigFileSnapshot();
  expect(fresh).toMatchObject({
    valid: true,
    sourceConfig: { messages: { responsePrefix: "after-consent" } },
  });
});

it.each(["config-write", "none"] as const)(
  "keeps desired and running inventory separate with failure=%s",
  async (failure) => {
    const root = makeTrackedTempDir("managed-install-inventory", roots);
    const stateDir = path.join(root, "state");
    const configPath = path.join(stateDir, "openclaw.json");
    isolateWorkspace(root);
    const config: OpenClawConfig = {};
    await writeIndex(loadIndex({ config, candidates: [], installRecords: {} }));
    const boot = resolveMetadata({ config, allowCurrent: false });
    setMetadata(boot, { config });
    expect((await listManagedPlugins({ config })).plugins).toEqual([]);

    const pluginRoot = resolvePluginInstallDir(
      "saved-candidate",
      path.join(stateDir, "extensions"),
    );
    const fixture = coldFixture(pluginRoot, "saved-candidate", { kind: "memory" });
    const committed = failure !== "config-write";
    const rejected = new Error(`intentional ${failure} failure`);
    const currentConfig = mockConfigFile(configPath, config, {
      error: committed ? undefined : rejected,
      receipt: true,
    });
    const applyRuntime = vi.fn(async () => {
      return { operationId: "install", generation: 1, pluginIds: [fixture.pluginId] };
    });
    const installed = persistPluginInstall({
      snapshot: { config, baseHash: undefined, writeOptions: {} },
      pluginId: fixture.pluginId,
      install: pathInstall(pluginRoot),
      applyRuntime,
      invalidateRuntimeCache: false,
      runtime: { log: vi.fn() },
    });
    if (failure === "none") {
      expect(await installed).toEqual(currentConfig());
    } else {
      await expect(installed).rejects.toBe(rejected);
    }
    expect((await readIndex())?.installRecords[fixture.pluginId] !== undefined).toBe(committed);
    const listed = (await inventory(currentConfig())).find(
      (plugin) => plugin.id === fixture.pluginId,
    );
    if (committed) {
      expect(listed).toMatchObject({ installed: true, enabled: true });
      expect(applyRuntime).toHaveBeenCalledOnce();
    } else {
      expect(listed).toBeUndefined();
      expect(applyRuntime).not.toHaveBeenCalled();
    }
    expect(currentMetadata()).toBe(boot);
    expect(boot.byPluginId.has(fixture.pluginId)).toBe(false);
    expect(fs.existsSync(fixture.runtimeMarker)).toBe(false);
  },
);

it("persists management disable while retaining the context-engine slot", async () => {
  const { pluginRoot, configPath, fixture } = workspace("synthetic-context-engine", {
    kind: "context-engine",
  });
  const config = pluginConfig(pluginRoot, fixture.pluginId, true);
  config.plugins!.slots = { contextEngine: fixture.pluginId, memory: "none" };
  const { actual } = await useRealConfigFile(configPath, config);
  await persistIndex(config, { [fixture.pluginId]: pathInstall(pluginRoot) });
  const disabled = await setManagedPluginEnabled({ pluginId: fixture.pluginId, enabled: false });
  expect(disabled.plugin).toMatchObject({ installed: true, enabled: false });
  const fresh = await actual.readConfigFileSnapshot();
  expect(fresh.valid).toBe(true);
  expect(fresh.config).toMatchObject(pluginConfig(pluginRoot, fixture.pluginId, false));
  expect(fresh.config.plugins?.slots).toMatchObject({ contextEngine: fixture.pluginId });

  expect(fs.existsSync(fixture.runtimeMarker)).toBe(false);
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, expect, it, vi } from "vitest";
import {
  applyExclusiveSlotSelectionMock as selectSlot,
  buildPluginSnapshotReportMock as snapshotReport,
  createEmptyUninstallActions,
  clearPluginRegistryLoadCacheMock as clearCache,
  enablePluginInConfigMock as enablePlugin,
  loadPluginManifestRegistryMock as loadManifests,
  planPluginUninstallMock as planUninstall,
  replaceConfigFileMock as replaceConfig,
  restorePersistedInstalledPluginIndexIfCurrentMock as restoreIndex,
  refreshPluginRegistryMock as refreshRegistry,
  resetPluginsCliTestState,
  pluginsCliRuntimeLogs,
  setInstalledPluginIndexInstallRecords,
  configWriteMock as writeConfig,
  writePersistedInstalledPluginIndexInstallRecordsWithLeaseMock as writeIndex,
  applyPluginUninstallDirectoryRemovalMock as removeDirectory,
  readConfigFileSnapshotForWriteMock as readConfig,
} from "../cli/plugins-cli-test-helpers.js";
import { createTestConfigSnapshot } from "../commands/test-runtime-config-helpers.js";
import type { OpenClawConfig } from "../config/config.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { prepareRealInstallMetadata } from "./install-persistence.test-support.js";
import type { PluginInstallRuntimeDeferral } from "./install-runtime-batch.js";
import { hasRetainedManagedNpmInstallMarker } from "./managed-npm-retention.js";
import { recordPluginManifestInstallOwner } from "./manifest-install-owner.js";
import type { PluginManifestRecord } from "./manifest-registry.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";
import { createPluginManifestRecordFixture } from "./plugin-metadata.test-support.js";
import type { PluginUninstallDirectoryRemoval } from "./uninstall.js";

async function persistPluginInstall(
  ...args: Parameters<typeof import("./install-persistence.js").persistPluginInstall>
) {
  const owner = await import("./install-persistence.js");
  return owner.persistPluginInstall(...args);
}

type PersistOptions = Parameters<typeof import("./install-persistence.js").persistPluginInstall>[0];
function persistNpm(
  pluginId: string,
  {
    config = { plugins: { entries: {} } },
    ...options
  }: Partial<PersistOptions> & { config?: OpenClawConfig } = {},
) {
  return persistPluginInstall({
    pluginId,
    snapshot: installSnapshot(config),
    install: npmInstall(`${pluginId}@1.0.0`),
    ...options,
  });
}

function npmInstall(spec: string, installPath = `/tmp/${spec.split("@")[0]}`) {
  return { source: "npm" as const, spec, installPath };
}

function temporaryInstall(label: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), label));
  return { root, [Symbol.dispose]: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function mockActiveSource(id: string, source: string, status?: string) {
  snapshotReport.mockReturnValue({
    plugins: [{ id, origin: "config", source, ...(status ? { status } : {}) }],
    diagnostics: [],
  });
}

function writeEnginePlugin(
  root: string,
  id: string,
  contextEngineIds?: readonly string[],
  marker?: string,
) {
  fs.mkdirSync(root, { recursive: true });
  const writeJson = (name: string, value: unknown) =>
    fs.writeFileSync(path.join(root, name), JSON.stringify(value));
  writeJson("package.json", {
    name: id,
    version: "1.0.0",
    openclaw: { extensions: ["./index.js"] },
  });
  fs.writeFileSync(
    path.join(root, "index.js"),
    `${marker ? `require("node:fs").writeFileSync(${JSON.stringify(marker)}, ${JSON.stringify(id)}); ` : ""}throw new Error('install must not execute plugin runtime');`,
  );
  writeJson("openclaw.plugin.json", {
    id,
    kind: "context-engine",
    contextEngineIds,
    configSchema: {},
  });
}

const requiredTokenSchema = {
  type: "object",
  required: ["token"],
  properties: { token: { type: "string" } },
};

function mockReplacedInstall(
  pluginId: string,
  previous: PluginInstallRecord & { installPath: string },
  cleanup?: PluginUninstallDirectoryRemoval["cleanup"],
) {
  setInstalledPluginIndexInstallRecords({ [pluginId]: previous });
  planUninstall.mockReturnValueOnce({
    ok: true,
    config: {},
    pluginId,
    actions: createEmptyUninstallActions(),
    directoryRemoval: { target: previous.installPath, ...(cleanup ? { cleanup } : {}) },
  });
}
function mockEnabledPlugin(pluginId: string): OpenClawConfig {
  const config = { plugins: { entries: { [pluginId]: { enabled: true } } } };
  enablePlugin.mockReturnValue({ config, enabled: true });
  return config;
}

function expectRuntimeLogIncludes(fragment: string) {
  expect(pluginsCliRuntimeLogs.join("\n")).toContain(fragment);
}

function setManifests(
  ...plugins: Array<Partial<PluginManifestRecord> & { id: string; owner?: string }>
) {
  loadManifests.mockReturnValue({
    plugins: plugins.map(({ id, owner = id, ...manifest }) =>
      recordPluginManifestInstallOwner(
        createPluginManifestRecordFixture({ id, origin: "config", ...manifest }),
        owner,
      ),
    ),
    diagnostics: [],
  });
}

const installWriteOptions = {
  assertConfigPathForWrite: () => {},
  expectedConfigPath: "/tmp/openclaw.json",
  ownedConfigPathForWrite: "/tmp/openclaw.json",
};

function installSnapshot(config: OpenClawConfig) {
  readConfig.mockResolvedValue({
    snapshot: { ...createTestConfigSnapshot(config), hash: "config-1" },
    writeOptions: installWriteOptions,
  });
  return { config, baseHash: "config-1", writeOptions: installWriteOptions };
}

beforeEach(() => {
  clearPluginMetadataLifecycleCaches();
  resetPluginsCliTestState();
});

it("hands durable batch facts to the coordinator before later output failure", async () => {
  const record = vi.fn();
  const deferRuntime = { record, deferCleanup: vi.fn() };
  const commit = vi.fn(async () => undefined);
  const rollback = vi.fn(async () => undefined);
  const failure = new Error("terminal output unavailable");
  const pending = persistNpm("alpha", {
    config: {},
    install: { source: "archive" as const, installPath: "/tmp/alpha" },
    enable: false,
    deferRuntime,
    transaction: { commit, rollback },
    runtime: {
      log: () => {
        throw failure;
      },
    },
  });
  await expect(pending).rejects.toMatchObject({ pluginId: "alpha", cause: failure });
  expect(record).toHaveBeenCalledOnce();
  expect(record.mock.calls[0]?.[0]).toMatchObject({
    pluginId: "alpha",
    operation: "install",
    sourceDigests: {},
  });
  expect(replaceConfig.mock.calls[0]?.[0]).toMatchObject({
    writeOptions: { afterWrite: { mode: "none" } },
  });
  expect(commit).toHaveBeenCalledOnce();
  expect(rollback).not.toHaveBeenCalled();
});

it.each<[string, boolean, string[] | undefined, string[] | undefined]>([
  ["new installation", true, undefined, ["canonical-engine"]],
  ["replaces obsolete ownership", true, ["obsolete-engine"], ["canonical-engine"]],
  ["removes retired declaration", true, ["obsolete-engine"], undefined],
  ["disabled retains ownership", false, undefined, ["canonical-engine"]],
])(
  "persists manifest engine selection and ownership: %s",
  async (_name, enabled, previousIds, declaredIds) => {
    await prepareRealInstallMetadata();
    using directory = temporaryInstall("openclaw-engine-install-");
    const rootDir = directory.root;
    writeEnginePlugin(rootDir, "vendor-plugin", declaredIds);
    if (previousIds) {
      setInstalledPluginIndexInstallRecords({
        "vendor-plugin": {
          source: "path",
          sourcePath: rootDir,
          contextEngineIdsByPlugin: { "vendor-plugin": previousIds },
        },
      });
    }
    const next = await persistNpm("vendor-plugin", {
      config: {},
      install: { source: "path", sourcePath: rootDir },
      enable: enabled,
    });
    const records = writeIndex.mock.calls[0]?.[0] ?? {};
    expect((records["vendor-plugin"] as Record<string, unknown>).contextEngineIdsByPlugin).toEqual(
      declaredIds ? { "vendor-plugin": declaredIds } : undefined,
    );
    expect(next.plugins?.slots?.contextEngine).toBe(
      enabled ? (declaredIds?.[0] ?? "vendor-plugin") : undefined,
    );
  },
);

it.each([
  ["sole legacy owner", false, false, "canonical-engine"],
  ["approved declared competitor", true, false, "vendor-plugin"],
  ["denied declared competitor", true, true, "canonical-engine"],
] as const)(
  "preserves current engine ownership during real install: %s",
  async (_name, competing, denied, selected) => {
    await prepareRealInstallMetadata();
    using directory = temporaryInstall("openclaw-owner-install-");
    const rootDir = directory.root;
    const vendorDir = path.join(rootDir, "vendor-plugin");
    const ownerDir = path.join(rootDir, "owner-a");
    const importMarker = path.join(rootDir, "runtime-imported");
    for (const [dir, id, contextEngineIds] of [
      [vendorDir, "vendor-plugin", ["canonical-engine"]],
      [ownerDir, "owner-a", ["vendor-plugin"]],
    ] as const) {
      writeEnginePlugin(dir, id, contextEngineIds, importMarker);
    }
    const config: OpenClawConfig = {
      plugins: {
        load: { paths: competing ? [ownerDir] : [] },
        entries: competing ? { "owner-a": { enabled: true } } : {},
        ...(denied ? { deny: ["owner-a"] } : {}),
        slots: { contextEngine: "vendor-plugin" },
      },
    };
    const next = await persistNpm("vendor-plugin", {
      config,
      install: { source: "path", sourcePath: vendorDir },
    });
    expect(next.plugins?.slots?.contextEngine).toBe(selected);
    expect(writeConfig).toHaveBeenCalledWith(next);
    expect(fs.existsSync(importMarker)).toBe(false);
  },
);

it.each(["before index", "at config publication"])(
  "rejects an expired owner %s and restores tentative state",
  async (phase) => {
    const expired = new Error("approved operation owner expired");
    let ownerActive = phase === "at config publication";
    const write = replaceConfig.getMockImplementation();
    if (!write) {
      throw new Error("missing config writer fixture");
    }
    replaceConfig.mockImplementationOnce(async (params) => {
      await Promise.resolve();
      ownerActive = false;
      await params.writeOptions?.beforeCommit?.();
      return await write(params);
    });
    await expect(
      persistNpm("alpha", {
        config: {},
        install: { source: "archive", sourcePath: "/tmp/alpha.tgz", installPath: "/tmp/alpha" },
        beforePersistentEffect: async () => {
          if (!ownerActive) {
            throw expired;
          }
        },
      }),
    ).rejects.toBe(expired);
    expect(writeIndex).toHaveBeenCalledTimes(phase === "before index" ? 0 : 1);
    expect(restoreIndex).toHaveBeenCalledTimes(phase === "before index" ? 0 : 1);
    expect(writeConfig).not.toHaveBeenCalled();
    expect(refreshRegistry).not.toHaveBeenCalled();
  },
);

it("persists installs even when runtime cache invalidation fails", async () => {
  const enabledConfig = mockEnabledPlugin("alpha");
  clearCache.mockImplementation(() => {
    throw new Error("cache unavailable");
  });

  const next = await persistNpm("alpha");

  expect(next).toEqual(enabledConfig);
  expectRuntimeLogIncludes("Plugin runtime cache invalidation failed");
});

it("removes a replaced managed install directory before refreshing the registry", async () => {
  mockEnabledPlugin("codex");
  const previousInstall = {
    source: "clawhub" as const,
    spec: "clawhub:@openclaw/codex",
    installPath: "/tmp/openclaw/extensions/codex",
  };
  mockReplacedInstall("codex", previousInstall);
  removeDirectory.mockResolvedValueOnce({
    directoryRemoved: true,
    warnings: [],
  });

  await persistNpm("codex", {
    install: npmInstall("@openclaw/codex", "/tmp/openclaw/npm/node_modules/@openclaw/codex"),
  });

  expect(removeDirectory.mock.calls.map(([removal]) => removal)).toEqual([
    { target: "/tmp/openclaw/extensions/codex" },
  ]);
  expect(removeDirectory).toHaveBeenCalledBefore(refreshRegistry);
  expectRuntimeLogIncludes(
    "Removed previous plugin install directory: /tmp/openclaw/extensions/codex",
  );
});

it("preserves replaced npm install directories across generation updates", async () => {
  mockEnabledPlugin("codex");
  using directory = temporaryInstall("openclaw-plugin-persist-");
  const tempRoot = directory.root;
  const previousProjectRoot = path.join(tempRoot, "npm", "projects", "codex-v1");
  const previousInstallPath = path.join(previousProjectRoot, "node_modules/@openclaw/codex");
  const nextInstallPath = path.join(tempRoot, "npm/projects/codex-v2/node_modules/@openclaw/codex");
  fs.mkdirSync(previousInstallPath, { recursive: true });
  const previousInstall = npmInstall("@openclaw/codex@1.0.0", previousInstallPath);
  mockReplacedInstall("codex", previousInstall, {
    kind: "npm",
    npmRoot: previousProjectRoot,
    packageName: "@openclaw/codex",
    rootKind: "isolated-project",
  });

  await persistNpm("codex", {
    install: npmInstall("@openclaw/codex@2.0.0", nextInstallPath),
  });

  expect(removeDirectory).not.toHaveBeenCalled();
  expect(hasRetainedManagedNpmInstallMarker(previousInstallPath)).toBe(true);
});

it("does not warn when the config-selected source is inside the npm install path", async () => {
  mockEnabledPlugin("discord");
  mockActiveSource(
    "discord",
    "/tmp/openclaw/npm/node_modules/@openclaw/discord/dist/index.js",
    "loaded",
  );

  await persistNpm("discord", {
    install: npmInstall("@openclaw/discord", "/tmp/openclaw/npm/node_modules/@openclaw/discord"),
  });

  expect(pluginsCliRuntimeLogs.join("\n")).not.toContain("is not the active source");
});
it("restores runtime child policy when reinstalling its package owner", async () => {
  const baseConfig: OpenClawConfig = {
    plugins: { allow: ["memory-core"], deny: ["demo-plugin-npm", "other"] },
  };
  setInstalledPluginIndexInstallRecords({
    "demo-package": { source: "npm", spec: "@openclaw/demo-package@0.0.1" },
  });
  setManifests({ id: "demo-plugin-npm", owner: "demo-package" });

  const next = await persistNpm("demo-package", {
    config: baseConfig,
    install: npmInstall("@openclaw/demo-package@0.0.1", "/tmp/demo-package"),
  });

  expect(next.plugins).toMatchObject({
    allow: ["memory-core", "demo-plugin-npm"],
    deny: ["other"],
  });
  expect(enablePlugin).toHaveBeenCalledTimes(1);
});

it.each(["needs-config", "MyPlug"])(
  "stages %s disabled under its canonical ID when settings are missing",
  async (pluginId) => {
    const warn = vi.fn();
    const policyId = pluginId.toLowerCase();
    const hooks = { timeoutMs: 5_000 };
    const allow = pluginId === "needs-config" ? ["memory-core"] : undefined;
    const baseConfig: OpenClawConfig = {
      plugins: {
        ...(allow ? { allow } : {}),
        deny: [policyId],
        entries: { [policyId]: { hooks } },
      },
    };
    setManifests({ id: pluginId, configSchema: requiredTokenSchema });
    const next = await persistNpm(pluginId, { config: baseConfig, persistenceLogger: { warn } });
    expect(next).toEqual({
      plugins: {
        ...(allow ? { allow: [...allow, policyId] } : {}),
        entries: { [policyId]: { enabled: false, hooks } },
      },
    });
    expect(enablePlugin).not.toHaveBeenCalled();
    expect(selectSlot).not.toHaveBeenCalled();
    const warning = `Installed plugin "${pluginId}" without enabling it because it requires configuration first.`;
    expectRuntimeLogIncludes(warning);
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      `${warning} Configure it, then run \`openclaw plugins enable ${pluginId}\`.`,
    );
    expect(pluginsCliRuntimeLogs).toContain(`Installed plugin: ${pluginId}`);
    expect(writeIndex.mock.calls[0]?.[0]).toMatchObject({
      [pluginId]: npmInstall(`${pluginId}@1.0.0`),
    });
  },
);

it("reads mixed-case manifest policy from canonical lowercase entries on reinstall", async () => {
  const baseConfig: OpenClawConfig = {
    plugins: {
      entries: {
        myplug: { enabled: true, config: { token: "abc" } },
        otherplug: { enabled: false, config: { token: "xyz" } },
      },
    },
  };
  setManifests(
    { id: "MyPlug", configSchema: requiredTokenSchema, owner: "my-package" },
    { id: "OtherPlug", configSchema: requiredTokenSchema, owner: "my-package" },
  );
  setInstalledPluginIndexInstallRecords({
    "my-package": { source: "npm", spec: "my-package@1.0.0" },
  });
  enablePlugin.mockImplementation((config) => ({ config, enabled: true }));

  const next = await persistNpm("my-package", { config: baseConfig });

  expect(next.plugins?.entries).toEqual(baseConfig.plugins?.entries);
  expect(enablePlugin).toHaveBeenCalledExactlyOnceWith(baseConfig, "MyPlug", expect.anything());
  expect(pluginsCliRuntimeLogs.join("\n")).not.toContain("requires configuration first");
});

it.each(["schema", "disabled config"] as const)("rejects invalid %s", async (kind) => {
  const malformedSchema = kind === "schema";
  const pluginId = malformedSchema ? "broken-schema" : "needs-config";
  const config: OpenClawConfig = malformedSchema
    ? {}
    : {
        plugins: { entries: { [pluginId]: { enabled: false, config: null as never } } },
      };
  const configSchema = malformedSchema
    ? { type: "object", properties: { mode: { $ref: "#/$defs/Mode" } } }
    : requiredTokenSchema;
  const enable = malformedSchema ? undefined : false;
  setManifests({ id: pluginId, configSchema });
  await expect(persistNpm(pluginId, { config, enable })).rejects.toThrow(
    "has invalid configured settings",
  );
  expect(enablePlugin).not.toHaveBeenCalled();
  expect(writeIndex).not.toHaveBeenCalled();
  expect(writeConfig).not.toHaveBeenCalled();
});

it("does not add disabled installs to restrictive allowlists", async () => {
  const baseConfig: OpenClawConfig = {
    plugins: { allow: ["memory-core"], deny: ["memory-lancedb"] },
  };

  const next = await persistNpm("memory-lancedb", {
    config: baseConfig,
    enable: false,
    install: {
      source: "path",
      spec: "memory-lancedb",
      sourcePath: "/app/dist/extensions/memory-lancedb",
      installPath: "/app/dist/extensions/memory-lancedb",
    },
  });

  expect(next.plugins).toMatchObject({ allow: ["memory-core"], deny: ["memory-lancedb"] });
  expect(next.plugins?.entries?.["memory-lancedb"]).toBeUndefined();
});
const install = {
  source: "npm" as const,
  spec: "workboard@1.0.0",
  installPath: "/private/managed-source/workboard",
};

it("delivers deferred source cleanup warnings to the live batch consumer", async () => {
  const cleanups: Parameters<PluginInstallRuntimeDeferral["deferCleanup"]>[0][] = [];
  const lateWarning = vi.fn();
  const warning = "Previous plugin source could not be removed";
  mockReplacedInstall("workboard", {
    source: "clawhub",
    installPath: "/private/previous-source/workboard",
  });
  removeDirectory.mockResolvedValueOnce({
    directoryRemoved: false,
    warnings: [warning],
  });
  await persistNpm("workboard", {
    config: {},
    install,
    enable: false,
    runtime: { log: () => {} },
    persistenceLogger: { warn: () => {} },
    deferRuntime: { record: () => {}, deferCleanup: (cleanup) => cleanups.push(cleanup) },
  });
  expect(removeDirectory).not.toHaveBeenCalled();
  expect(cleanups).toHaveLength(1);
  await cleanups[0]!(() => {}, lateWarning);
  expect(lateWarning).toHaveBeenCalledExactlyOnceWith(warning);
});

it("keeps sensitive install details appropriate for the management audience", async () => {
  const warn = vi.fn();
  const cleanupDetail = "npm stderr PRIVATE_NPM_MARKER /private/previous-source/workboard";
  const refreshDetail = "PRIVATE_REFRESH_MARKER /private/registry-source/workboard";
  const configuredSource = "/private/configured-source/workboard/index.js";
  mockReplacedInstall("workboard", {
    source: "clawhub",
    spec: "clawhub:community/workboard",
    installPath: "/private/previous-source/workboard",
  });
  removeDirectory.mockResolvedValueOnce({
    directoryRemoved: false,
    warnings: [cleanupDetail],
  });
  refreshRegistry.mockImplementationOnce(async () => {
    expect(writeConfig).toHaveBeenCalledOnce();
    throw new Error(refreshDetail);
  });
  mockActiveSource("workboard", configuredSource);

  await persistNpm("workboard", { config: {}, install, persistenceLogger: { warn } });

  const warnings = warn.mock.calls.map(([message]) => String(message));
  expect(warnings).toHaveLength(3);
  const warningText = warnings.join("\n");
  const runtimeText = pluginsCliRuntimeLogs.join("\n");
  expect(warningText).toContain("previous plugin installation");
  expect(warningText).toContain("registry");
  expect(warningText).toContain("shadowed");
  expect(warningText).not.toContain("/private/");
  expect(warningText).not.toContain("PRIVATE_NPM_MARKER");
  expect(warningText).not.toContain("PRIVATE_REFRESH_MARKER");
  expect(runtimeText).toContain(cleanupDetail);
  expect(runtimeText).toContain(refreshDetail);
  expect(runtimeText).toContain(configuredSource);
  expect(runtimeText).toContain(install.installPath);
});

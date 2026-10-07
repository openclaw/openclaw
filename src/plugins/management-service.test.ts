import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginsReloadParams } from "../../packages/gateway-protocol/src/schema/plugins.js";
import { createDeferred } from "../../test/helpers/promise.js";
import { assertConfigWriteAllowedInCurrentMode } from "../config/config-write-guard.js";
import { buildPluginCapabilitySummary, computeDeclaredSurfaceHash } from "./capability-summary.js";
import { hashStableJson } from "./installed-plugin-index-hash.js";
import { recordInstalledPluginIndexInstallOwner } from "./installed-plugin-index-install-owner.js";
import type { PluginLifecycleRuntimeApply } from "./lifecycle.js";
import { ManagedPluginLifecycleError } from "./management-lifecycle-error.js";
import {
  configSnapshot,
  emptyMetadataSnapshot,
  metadataSnapshot,
} from "./management-service.test-helpers.js";

const mocks = vi.hoisted(() => ({
  applyUninstall: vi.fn(),
  clawReferenceWarnings: vi.fn(),
  commitRecords: vi.fn(),
  installRecords: vi.fn(),
  metadata: vi.fn(),
  officialCatalog: vi.fn(),
  preflight: vi.fn(),
  pluginVersionCategories: vi.fn(),
  readConfig: vi.fn(),
  readPersistedRecords: vi.fn(),
  refreshRegistry: vi.fn(),
  replaceConfig: vi.fn(),
  planUninstall: vi.fn(),
  selectWriteOptions: vi.fn((writeOptions: unknown) => writeOptions),
  slotSelection: vi.fn((config: unknown) => config),
}));

vi.mock("../config/config.js", () => ({
  assertConfigWriteAllowedInCurrentMode: (params?: { env?: NodeJS.ProcessEnv }) => {
    assertConfigWriteAllowedInCurrentMode(params);
  },
  readConfigFileSnapshot: async () => (await mocks.readConfig()).snapshot,
  readConfigFileSnapshotForWrite: () => mocks.readConfig(),
  replaceConfigFile: (params: unknown) => mocks.replaceConfig(params),
}));

vi.mock("../config/io.factory.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/io.factory.js")>();
  return {
    ...actual,
    createConfigIO: (options: Parameters<typeof actual.createConfigIO>[0]) => ({
      ...actual.createConfigIO(options),
      readConfigFileSnapshotForWrite: () => mocks.readConfig(),
    }),
  };
});

vi.mock("./install-config-mutation.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./install-config-mutation.js")>()),
  resolveInstallConfigMutationPreflights: (...args: unknown[]) => mocks.preflight(...args),
  selectInstallMutationWriteOptions: (writeOptions: unknown) =>
    mocks.selectWriteOptions(writeOptions),
}));

vi.mock("./slot-selection.js", () => ({
  applySlotSelectionForPlugin: (config: unknown) => mocks.slotSelection(config),
}));

vi.mock("./registry-refresh.js", () => ({
  refreshPluginRegistryAfterConfigMutation: (...args: unknown[]) => mocks.refreshRegistry(...args),
}));

vi.mock("./plugin-metadata-snapshot.js", () => ({
  loadPluginMetadataSnapshot: (...args: unknown[]) => mocks.metadata(...args),
  resolvePluginMetadataSnapshot: (...args: unknown[]) => mocks.metadata(...args),
}));

vi.mock("./installed-plugin-index-records.js", async (importOriginal) => ({
  // Keep the pure config/record helpers real; only record IO is stubbed.
  ...(await importOriginal<typeof import("./installed-plugin-index-records.js")>()),
  loadInstalledPluginIndexInstallRecords: (...args: unknown[]) => mocks.installRecords(...args),
  readPersistedInstalledPluginIndexInstallRecords: (...args: unknown[]) =>
    mocks.readPersistedRecords(...args),
}));

vi.mock("./uninstall.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./uninstall.js")>()),
  applyPluginUninstallDirectoryRemoval: (...args: unknown[]) => mocks.applyUninstall(...args),
  planPluginUninstall: (...args: unknown[]) => mocks.planUninstall(...args),
}));

vi.mock("./install-record-commit.js", () => ({
  commitPluginInstallRecordsWithConfig: (...args: unknown[]) => mocks.commitRecords(...args),
}));

vi.mock("./uninstall-claw-references.js", () => ({
  collectClawPluginUninstallWarnings: (...args: unknown[]) => mocks.clawReferenceWarnings(...args),
}));

vi.mock("./official-external-plugin-catalog.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./official-external-plugin-catalog.js")>()),
  loadConfiguredHostedOfficialExternalPluginCatalogEntries: (...args: unknown[]) =>
    mocks.officialCatalog(...args),
}));

vi.mock("../infra/clawhub-plugin-catalog.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/clawhub-plugin-catalog.js")>()),
  fetchClawHubPluginVersionCategories: (...args: unknown[]) =>
    mocks.pluginVersionCategories(...args),
}));

const { clearManagedPluginCatalogCache } = await import("./management-catalog.js");
const { listManagedPlugins } = await import("./management-service.js");
const { setManagedPluginEnabled, reloadManagedPlugin } = await import("./management-mutations.js");
const { uninstallManagedPlugin } = await import("./management-uninstall.js");

function mockHostedOfficialCatalog(entries: unknown[]) {
  mocks.officialCatalog.mockResolvedValue({
    source: "hosted",
    entries,
    feed: { schemaVersion: 1, id: "test", generatedAt: "now", sequence: 1, entries: [] },
    metadata: { url: "https://clawhub.ai/feed", status: 200, checksum: "hash" },
  });
}

describe("plugin management service", () => {
  beforeEach(() => {
    clearManagedPluginCatalogCache();
    for (const mock of Object.values(mocks)) {
      if (typeof mock === "function" && "mockReset" in mock) {
        mock.mockReset();
      }
    }
    mocks.selectWriteOptions.mockImplementation((writeOptions) => writeOptions);
    mocks.preflight.mockReturnValue({
      hookMutation: { mode: "allowed" },
      pluginMutation: { mode: "allowed" },
    });
    mocks.slotSelection.mockImplementation((config) => config);
    mocks.installRecords.mockResolvedValue({});
    mocks.applyUninstall.mockResolvedValue({ directoryRemoved: true, warnings: [] });
    mocks.pluginVersionCategories.mockResolvedValue([]);
    mocks.clawReferenceWarnings.mockReturnValue([]);
    mockHostedOfficialCatalog([]);
  });

  it.each(["batch", "cross-owner"] as const)(
    "validates current package owners before targeted reload: %s",
    async (mode) => {
      const acceptedSurface = buildPluginCapabilitySummary({
        manifest: {},
        origin: "global",
      }).declared;
      const record = (id: string) => ({
        source: "path",
        installPath: `/tmp/${id}`,
        acceptedSurface,
        acceptedSurfaceHash: computeDeclaredSurfaceHash(acceptedSurface),
      });
      const first = metadataSnapshot({
        enabled: true,
        id: "first",
        origin: "global",
        installRecord: record("first"),
      });
      const second = metadataSnapshot({
        enabled: true,
        id: "second",
        origin: "global",
        installRecord: record("second"),
      });
      const config = {
        plugins: { entries: { first: { enabled: true }, second: { enabled: true } } },
      };
      mocks.readConfig.mockResolvedValue(configSnapshot(config));
      mocks.readPersistedRecords.mockReturnValue({
        ...first.index.installRecords,
        ...second.index.installRecords,
      });
      mocks.metadata.mockReturnValue({
        ...first,
        index: {
          plugins: [...first.index.plugins, ...second.index.plugins],
          installRecords: { ...first.index.installRecords, ...second.index.installRecords },
        },
        plugins: [...first.plugins, ...second.plugins],
        byPluginId: new Map([...first.byPluginId, ...second.byPluginId]),
      });
      const application = {
        operationId: "reload",
        generation: 4,
        pluginIds: ["first", "second"],
      };
      const applyRuntime = vi.fn<PluginLifecycleRuntimeApply>(async (request) => {
        request.assertInvokerOwned?.();
        expect(request.config).toEqual(config);
        expect(request.pluginIds).toEqual(application.pluginIds);
        expect(request.expectedSourceDigests).toEqual({
          first: "a".repeat(64),
          second: "b".repeat(64),
        });
        expect(request.expectedInstallHashes).toEqual({
          first: hashStableJson(first.index.installRecords.first),
          second: hashStableJson(second.index.installRecords.second),
        });
        return application;
      });
      const request: PluginsReloadParams = {
        plugins: [
          {
            pluginId: "first",
            installHash: hashStableJson(first.index.installRecords.first),
            sourceDigests:
              mode === "cross-owner" ? { second: "a".repeat(64) } : { first: "a".repeat(64) },
          },
          {
            pluginId: "second",
            installHash: hashStableJson(second.index.installRecords.second),
            sourceDigests: { second: "b".repeat(64) },
          },
        ],
      };
      const pending = reloadManagedPlugin({ ...request, applyRuntime, env: {} });
      if (mode === "cross-owner") {
        await expect(pending).rejects.toThrow("different package owner");
        expect(applyRuntime).not.toHaveBeenCalled();
      } else {
        await expect(pending).resolves.toMatchObject({ application });
        expect(applyRuntime).toHaveBeenCalledOnce();
      }
      expect(mocks.replaceConfig).not.toHaveBeenCalled();
    },
  );

  it("reloads a discovered plugin without inventing an installed package record", async () => {
    const origin = "config";
    const signal = new AbortController().signal;
    const metadata = metadataSnapshot({ enabled: true, id: "discovered" });
    mocks.metadata.mockReturnValue({
      ...metadata,
      index: {
        ...metadata.index,
        plugins: metadata.index.plugins.map((plugin) => ({ ...plugin, origin })),
      },
      byPluginId: new Map(metadata.plugins.map((plugin) => [plugin.id, { ...plugin, origin }])),
    });
    mocks.readConfig.mockResolvedValue(configSnapshot());
    const applyRuntime = vi.fn<PluginLifecycleRuntimeApply>(async (request) => {
      request.assertInvokerOwned?.();
      expect(request.expectedInstallHashes).toBeUndefined();
      return {
        operationId: "discovered-reload",
        generation: 4,
        pluginIds: [...request.pluginIds],
      };
    });
    await expect(
      reloadManagedPlugin({
        plugins: [{ pluginId: "discovered", sourceDigests: { discovered: "a".repeat(64) } }],
        env: {},
        waitForDrain: true,
        signal,
        applyRuntime,
      }),
    ).resolves.toMatchObject({ pluginIds: ["discovered"], application: { generation: 4 } });
    expect(applyRuntime).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        pluginIds: ["discovered"],
        waitForDrain: true,
        drainSignal: signal,
        expectedSourceDigests: { discovered: "a".repeat(64) },
      }),
    );
    expect(mocks.commitRecords).not.toHaveBeenCalled();
    expect(mocks.replaceConfig).not.toHaveBeenCalled();
  });

  it.each([
    "install-hash-without-record",
    "ambiguous-owner",
    "missing-record",
    "record-id-without-owner",
    "record-path-without-owner",
    "conflicting-owner",
  ] as const)("rejects an invalid managed reload claim: %s", async (claim) => {
    const metadata = metadataSnapshot({ enabled: true, id: "discovered" });
    const plugin = { ...metadata.index.plugins[0]!, origin: "config" as const };
    const record = { source: "path", installPath: plugin.rootDir };
    const records: Record<string, typeof record> = {};
    if (claim === "ambiguous-owner") {
      recordInstalledPluginIndexInstallOwner(plugin, undefined, true);
    } else if (claim === "missing-record" || claim === "conflicting-owner") {
      recordInstalledPluginIndexInstallOwner(plugin, "package");
    }
    if (claim === "record-id-without-owner" || claim === "conflicting-owner") {
      records.discovered = record;
    }
    if (claim === "record-path-without-owner" || claim === "conflicting-owner") {
      records.package = record;
    }
    mocks.metadata.mockReturnValue({
      ...metadata,
      index: { plugins: [plugin], installRecords: records },
    });
    mocks.readConfig.mockResolvedValue(configSnapshot());
    mocks.readPersistedRecords.mockReturnValue(records);
    const applyRuntime = vi.fn<PluginLifecycleRuntimeApply>();
    await expect(
      reloadManagedPlugin({
        plugins: [
          {
            pluginId: "discovered",
            ...(claim === "install-hash-without-record" ? { installHash: "a".repeat(64) } : {}),
          },
        ],
        env: {},
        applyRuntime,
      }),
    ).rejects.toBeInstanceOf(ManagedPluginLifecycleError);
    expect(applyRuntime).not.toHaveBeenCalled();
    expect(mocks.commitRecords).not.toHaveBeenCalled();
    expect(mocks.replaceConfig).not.toHaveBeenCalled();
  });

  it.each(["OPENCLAW_NIX_MODE", "OPENCLAW_CONFIG_READONLY"])(
    "refuses mutation in %s before reading or writing config",
    async (mode) => {
      await expect(
        setManagedPluginEnabled({
          pluginId: "workboard",
          enabled: true,
          env: { [mode]: "1" },
        }),
      ).rejects.toThrow(`${mode}=1`);
      expect(mocks.readConfig).not.toHaveBeenCalled();
      expect(mocks.replaceConfig).not.toHaveBeenCalled();
      mocks.metadata.mockReturnValue(emptyMetadataSnapshot());
      const catalog = await listManagedPlugins({
        config: {},
        env: { [mode]: "1" },
        officialCatalog: { entries: [] },
      });
      expect(catalog.mutationAllowed).toBe(false);
    },
  );

  it("blocks unsupported plugin includes before config mutation", async () => {
    mocks.readConfig.mockResolvedValue(configSnapshot());
    mocks.preflight.mockReturnValue({
      hookMutation: { mode: "allowed" },
      pluginMutation: { mode: "blocked", reason: "nested plugins include" },
    });

    await expect(
      setManagedPluginEnabled({ pluginId: "workboard", enabled: true, env: {} }),
    ).rejects.toThrow("nested plugins include");
    expect(mocks.replaceConfig).not.toHaveBeenCalled();
  });

  it("keeps an explicit deny authoritative for admin enablement", async () => {
    const config = {
      plugins: {
        allow: ["memory-core"],
        deny: ["workboard"],
        entries: { workboard: { enabled: false } },
      },
    };
    mocks.readConfig.mockResolvedValue(configSnapshot(config));
    mocks.metadata.mockReturnValue(metadataSnapshot({ enabled: false }));

    await expect(
      setManagedPluginEnabled({ pluginId: "workboard", enabled: true, env: {} }),
    ).rejects.toThrow('plugin "workboard" could not be enabled (blocked by denylist)');
    expect(mocks.replaceConfig).not.toHaveBeenCalled();
  });

  it("does not turn an empty allowlist into a restrictive one", async () => {
    const config = {
      plugins: {
        allow: [],
        entries: { workboard: { enabled: false } },
      },
    };
    mocks.readConfig.mockResolvedValue(configSnapshot(config));
    mocks.replaceConfig.mockResolvedValue({});
    mocks.refreshRegistry.mockResolvedValue(undefined);
    mocks.metadata
      .mockReturnValueOnce(metadataSnapshot({ enabled: false }))
      .mockReturnValueOnce(metadataSnapshot({ enabled: true }));

    await setManagedPluginEnabled({ pluginId: "workboard", enabled: true, env: {} });

    expect(mocks.replaceConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceConfig: {
          plugins: {
            allow: [],
            entries: { workboard: { enabled: true } },
          },
        },
      }),
    );
  });

  it("retains files and tracking when authority is revoked during drain", async () => {
    const config = { plugins: { entries: { diffs: { enabled: true } } } };
    const record = {
      source: "clawhub",
      spec: "clawhub:@openclaw/diffs",
      installPath: "/tmp/extensions/diffs",
    };
    mocks.readConfig.mockResolvedValue(configSnapshot(config));
    mocks.installRecords.mockResolvedValue({ diffs: record });
    mocks.metadata.mockReturnValue(
      metadataSnapshot({ enabled: true, id: "diffs", origin: "global", installRecord: record }),
    );
    mocks.planUninstall.mockReturnValue({
      ok: true,
      config,
      pluginId: "diffs",
      actions: {
        entry: true,
        install: true,
        allowlist: false,
        denylist: false,
        loadPath: false,
        memorySlot: false,
        contextEngineSlot: false,
        channelConfig: false,
        directory: false,
      },
      directoryRemoval: { target: record.installPath },
    });
    mocks.replaceConfig.mockResolvedValue({ path: "/tmp/openclaw.json", nextConfig: config });
    const entered = createDeferred();
    const release = createDeferred();
    const revoked = new Error("authority revoked");
    let owned = true;
    const pending = uninstallManagedPlugin({
      pluginId: "diffs",
      env: {},
      applyRuntime: async () => {
        entered.resolve();
        await release.promise;
        owned = false;
        return { operationId: "uninstall", generation: 2, pluginIds: ["diffs"] };
      },
      beforePersistentApply: () => {
        if (!owned) {
          throw revoked;
        }
      },
    });
    try {
      await Promise.race([
        entered.promise,
        pending.then(() => {
          throw new Error("uninstall finished before drain");
        }),
      ]);
      expect(mocks.applyUninstall).not.toHaveBeenCalled();
      expect(mocks.commitRecords).not.toHaveBeenCalled();
      expect(mocks.replaceConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          writeOptions: expect.objectContaining({
            afterWrite: { mode: "none", reason: "plugin lifecycle applies runtime" },
          }),
        }),
      );
    } finally {
      release.resolve();
    }
    await expect(pending).rejects.toBe(revoked);
    expect(mocks.applyUninstall).not.toHaveBeenCalled();
    expect(mocks.commitRecords).not.toHaveBeenCalled();
  });

  it("refuses to uninstall bundled plugins", async () => {
    mocks.readConfig.mockResolvedValue(configSnapshot());
    mocks.installRecords.mockResolvedValue({});
    mocks.metadata.mockReturnValue(metadataSnapshot({ enabled: false }));

    await expect(uninstallManagedPlugin({ pluginId: "workboard", env: {} })).rejects.toThrow(
      "bundled plugin cannot be uninstalled",
    );
    expect([mocks.commitRecords.mock.calls, mocks.applyUninstall.mock.calls]).toEqual([[], []]);
  });

  it("rejects uninstalling an unknown plugin before mutation", async () => {
    mocks.readConfig.mockResolvedValue(configSnapshot());
    mocks.installRecords.mockResolvedValue({});
    mocks.metadata.mockReturnValue(emptyMetadataSnapshot());

    await expect(uninstallManagedPlugin({ pluginId: "ghost", env: {} })).rejects.toThrow(
      "Plugin not found: ghost",
    );
    expect(mocks.commitRecords).not.toHaveBeenCalled();
  });
});

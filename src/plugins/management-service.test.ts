import { expectDefined } from "@openclaw/normalization-core";
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
  clawhubInstall: vi.fn(),
  commitRecords: vi.fn(),
  installRecords: vi.fn(),
  metadata: vi.fn(),
  npmInstall: vi.fn(),
  officialCatalog: vi.fn(),
  persistInstall: vi.fn(),
  preflight: vi.fn(),
  pluginVersionCategories: vi.fn(),
  readConfig: vi.fn(),
  readPersistedRecords: vi.fn(),
  refreshRegistry: vi.fn(),
  replaceConfig: vi.fn(),
  planUninstall: vi.fn(),
  selectWriteOptions: vi.fn((writeOptions: unknown) => writeOptions),
  slotSelection: vi.fn((config: unknown): { config: unknown; warnings: string[] } => ({
    config,
    warnings: [],
  })),
}));

vi.mock("../config/config.js", () => ({
  assertConfigWriteAllowedInCurrentMode: (params?: { env?: NodeJS.ProcessEnv }) => {
    assertConfigWriteAllowedInCurrentMode(params);
  },
  readConfigFileSnapshot: async () => (await mocks.readConfig()).snapshot,
  readConfigFileSnapshotForWrite: () => mocks.readConfig(),
  replaceConfigFile: (params: unknown) => mocks.replaceConfig(params),
}));

vi.mock("./install-persistence.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./install-persistence.js")>()),
  persistPluginInstall: (...args: unknown[]) => mocks.persistInstall(...args),
}));

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

vi.mock("./clawhub.js", () => ({
  installPluginFromClawHub: (...args: unknown[]) => mocks.clawhubInstall(...args),
}));

vi.mock("./install.js", () => ({
  installPluginFromNpmSpec: (...args: unknown[]) => mocks.npmInstall(...args),
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
    mocks.slotSelection.mockImplementation((config) => ({ config, warnings: [] }));
    mocks.installRecords.mockResolvedValue({});
    mocks.applyUninstall.mockResolvedValue({ directoryRemoved: true, warnings: [] });
    mocks.pluginVersionCategories.mockResolvedValue([]);
    mocks.clawReferenceWarnings.mockReturnValue([]);
    mockHostedOfficialCatalog([]);
  });

  it.each(["batch", "one-target", "changed", "cross-owner"] as const)(
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
        pluginIds: mode === "one-target" ? ["first"] : ["first", "second"],
      };
      const applyRuntime = vi.fn<PluginLifecycleRuntimeApply>(async (request) => {
        request.assertInvokerOwned?.();
        expect(request.config).toEqual(config);
        expect(request.pluginIds).toEqual(application.pluginIds);
        expect(request.expectedSourceDigests).toEqual(
          mode === "one-target" ? undefined : { first: "a".repeat(64), second: "b".repeat(64) },
        );
        expect(request.expectedInstallHashes).toEqual(
          mode === "one-target"
            ? undefined
            : {
                first: hashStableJson(first.index.installRecords.first),
                second: hashStableJson(second.index.installRecords.second),
              },
        );
        return application;
      });
      const request: PluginsReloadParams =
        mode === "one-target"
          ? { plugins: [{ pluginId: "first" }] }
          : {
              plugins: [
                {
                  pluginId: "first",
                  installHash:
                    mode === "changed"
                      ? "0".repeat(64)
                      : hashStableJson(first.index.installRecords.first),
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
      if (mode === "changed" || mode === "cross-owner") {
        await expect(pending).rejects.toThrow(
          mode === "changed" ? "changed after" : "different package owner",
        );
        expect(applyRuntime).not.toHaveBeenCalled();
      } else {
        await expect(pending).resolves.toMatchObject({ application });
        expect(applyRuntime).toHaveBeenCalledOnce();
      }
      expect(mocks.replaceConfig).not.toHaveBeenCalled();
    },
  );

  it.each(["bundled", "config"] as const)(
    "reloads a known %s plugin without inventing an installed package record",
    async (origin) => {
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
          applyRuntime,
        }),
      ).resolves.toMatchObject({ pluginIds: ["discovered"], application: { generation: 4 } });
      expect(applyRuntime).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          pluginIds: ["discovered"],
          expectedSourceDigests: { discovered: "a".repeat(64) },
        }),
      );
      expect(mocks.commitRecords).not.toHaveBeenCalled();
      expect(mocks.replaceConfig).not.toHaveBeenCalled();
    },
  );

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

  it("preserves config hash and include ownership when enabling Workboard", async () => {
    const env = { HOME: "/tmp/openclaw-managed-toggle-home" };
    const prepared = configSnapshot({
      agents: { defaults: { workspace: "~/managed-toggle-workspace" } },
    });
    mocks.readConfig.mockResolvedValue(prepared);
    mocks.metadata
      .mockReturnValueOnce(metadataSnapshot({ enabled: false }))
      .mockReturnValueOnce(metadataSnapshot({ enabled: true }));
    mocks.replaceConfig.mockResolvedValue({});
    mocks.refreshRegistry.mockResolvedValue(undefined);

    const result = await setManagedPluginEnabled({
      pluginId: "workboard",
      enabled: true,
      env,
    });

    expect(mocks.metadata).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        config: prepared.snapshot.sourceConfig,
        env,
        workspaceDir: "/tmp/openclaw-managed-toggle-home/managed-toggle-workspace",
      }),
    );
    expect(mocks.metadata).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        env,
        workspaceDir: "/tmp/openclaw-managed-toggle-home/managed-toggle-workspace",
      }),
    );
    expect(mocks.replaceConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        baseHash: "base-hash",
        writeOptions: {
          ...prepared.writeOptions,
          assertConfigPathForWrite: expect.any(Function),
        },
      }),
    );
    expect(mocks.refreshRegistry).toHaveBeenCalledWith(
      expect.objectContaining({
        env,
        reason: "policy-changed",
        policyPluginIds: ["workboard"],
      }),
    );
    expect(result).toMatchObject({
      plugin: { id: "workboard", enabled: true, state: "enabled" },
      changedPaths: ["plugins"],
    });
  });

  it("adds an admin-selected plugin to an existing restrictive allowlist", async () => {
    const config = {
      plugins: {
        allow: ["memory-core"],
        entries: { workboard: { enabled: false } },
      },
    };
    mocks.readConfig.mockResolvedValue(configSnapshot(config));
    mocks.replaceConfig.mockResolvedValue({});
    mocks.refreshRegistry.mockResolvedValue(undefined);
    mocks.metadata
      .mockReturnValueOnce(metadataSnapshot({ enabled: false }))
      .mockReturnValueOnce(metadataSnapshot({ enabled: true }));

    const result = await setManagedPluginEnabled({
      pluginId: "workboard",
      enabled: true,
      env: {},
    });

    expect(mocks.replaceConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceConfig: {
          plugins: {
            allow: ["memory-core", "workboard"],
            entries: { workboard: { enabled: true } },
          },
        },
      }),
    );
    expect(result.changedPaths).toEqual(["plugins.allow[1]", "plugins.entries.workboard.enabled"]);
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

  it("reports exclusive-slot side effects in established plugin config", async () => {
    const config = {
      plugins: {
        entries: { workboard: { enabled: false } },
        slots: { memory: "memory-core" },
      },
    };
    mocks.readConfig.mockResolvedValue(configSnapshot(config));
    mocks.slotSelection.mockImplementation((next) => ({
      config: {
        ...(next as Record<string, unknown>),
        plugins: {
          ...(next as { plugins?: Record<string, unknown> }).plugins,
          slots: { memory: "workboard" },
        },
      },
      warnings: ["Selected workboard for the memory slot."],
    }));
    mocks.replaceConfig.mockResolvedValue({});
    mocks.refreshRegistry.mockResolvedValue(undefined);
    mocks.metadata
      .mockReturnValueOnce(metadataSnapshot({ enabled: false }))
      .mockReturnValueOnce(metadataSnapshot({ enabled: true }));

    const result = await setManagedPluginEnabled({
      pluginId: "workboard",
      enabled: true,
      env: {},
    });

    expect(result.changedPaths).toEqual([
      "plugins.entries.workboard.enabled",
      "plugins.slots.memory",
    ]);
    expect(result.warnings).toEqual(["Selected workboard for the memory slot."]);
  });

  it("marks external installs removable and bundled plugins non-removable", async () => {
    mocks.metadata.mockReturnValue(
      metadataSnapshot({
        enabled: true,
        id: "diffs",
        name: "Diffs",
        origin: "global",
        installRecord: { source: "clawhub", installPath: "/tmp/extensions/diffs" },
      }),
    );
    const external = await listManagedPlugins({
      config: {},
      env: {},
      officialCatalog: { entries: [] },
    });
    expect(external.plugins[0]).toMatchObject({ id: "diffs", removable: true });

    mocks.metadata.mockReturnValue(metadataSnapshot({ enabled: false }));
    const bundled = await listManagedPlugins({
      config: {},
      env: {},
      officialCatalog: { entries: [] },
    });
    expect(bundled.plugins[0]).toMatchObject({ id: "workboard", removable: false });
  });

  it.each(["complete", "drain rejects", "authority revoked"])(
    "keeps external plugin files and tracking until owned drain completes: %s",
    async (outcome) => {
      const env = { HOME: "/tmp/openclaw-managed-uninstall-home" };
      const installRecord = {
        source: "clawhub",
        spec: "clawhub:@openclaw/diffs",
        installPath: "/tmp/extensions/diffs",
      };
      const prepared = configSnapshot({
        agents: { defaults: { workspace: "~/managed-uninstall-workspace" } },
        plugins: { entries: { diffs: { enabled: true } } },
      });
      mocks.readConfig.mockResolvedValue(prepared);
      mocks.installRecords.mockResolvedValue({ diffs: installRecord });
      mocks.metadata.mockReturnValue(
        metadataSnapshot({
          enabled: true,
          id: "diffs",
          name: "Diffs",
          origin: "global",
          installRecord,
        }),
      );
      mocks.planUninstall.mockReturnValue({
        ok: true,
        config: { plugins: { installs: { diffs: installRecord } } },
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
        directoryRemoval: { target: "/tmp/extensions/diffs" },
      });
      mocks.commitRecords.mockResolvedValue({
        configWrite: { persistedHash: "final-hash", persistedSourceConfig: {} },
      });
      mocks.applyUninstall.mockResolvedValue({ directoryRemoved: true, warnings: [] });
      mocks.clawReferenceWarnings.mockReturnValue([
        'Warning: plugin "diffs" is referenced by Claw: @acme/review.',
      ]);
      mocks.refreshRegistry.mockResolvedValue(undefined);

      const entered = createDeferred();
      const release = createDeferred();
      const application = { operationId: "uninstall-test", generation: 2, pluginIds: ["diffs"] };
      const failure = new Error(outcome);
      let invokerOwned = true;
      const applyRuntime = vi.fn(
        async (
          _change: Parameters<
            NonNullable<Parameters<typeof uninstallManagedPlugin>[0]["applyRuntime"]>
          >[0],
        ) => {
          entered.resolve();
          await release.promise;
          if (outcome === "drain rejects") {
            throw failure;
          }
          if (outcome === "authority revoked") {
            invokerOwned = false;
          }
          return application;
        },
      );
      const pending = uninstallManagedPlugin({
        pluginId: "diffs",
        env,
        applyRuntime,
        beforePersistentApply: () => {
          if (!invokerOwned) {
            throw failure;
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
      if (outcome !== "complete") {
        await expect(pending).rejects.toBe(failure);
        expect(mocks.applyUninstall).not.toHaveBeenCalled();
        expect(mocks.commitRecords).not.toHaveBeenCalled();
        return;
      }
      const result = await pending;
      expect(applyRuntime).toHaveBeenCalledTimes(2);
      expect(result.application).toEqual(application);
      expect(applyRuntime.mock.calls[1]?.[0]).toMatchObject({
        write: { persistedHash: "final-hash", persistedSourceConfig: {} },
      });

      expect(mocks.installRecords).toHaveBeenCalledWith({ env });
      expect(mocks.metadata).toHaveBeenCalledWith(
        expect.objectContaining({
          env,
          workspaceDir: "/tmp/openclaw-managed-uninstall-home/managed-uninstall-workspace",
        }),
      );
      expect(mocks.planUninstall).toHaveBeenCalledWith(
        expect.objectContaining({ pluginId: "diffs", deleteFiles: true }),
      );
      expect(mocks.commitRecords).toHaveBeenCalledWith(
        expect.objectContaining({
          previousInstallRecords: { diffs: installRecord },
          nextInstallRecords: {},
          baseHash: "base-hash",
          writeOptions: {
            ...prepared.writeOptions,
            assertConfigPathForWrite: expect.any(Function),
            allowConfigSizeDrop: true,
            afterWrite: { mode: "none", reason: "plugin lifecycle applies runtime" },
          },
        }),
      );
      expect(
        expectDefined(
          mocks.commitRecords.mock.calls[0],
          "mocks.commitRecords.mock.calls[0] test invariant",
        )[0].nextConfig.plugins?.installs,
      ).toBeUndefined();
      expect(mocks.applyUninstall).toHaveBeenCalledWith(
        { target: "/tmp/extensions/diffs" },
        expect.any(Function),
      );
      expect(mocks.refreshRegistry).toHaveBeenCalledWith(
        expect.objectContaining({
          env,
          reason: "source-changed",
          installRecords: {},
        }),
      );
      expect(result).toMatchObject({
        pluginId: "diffs",
        removed: ["plugin settings", "install record", "directory"],
        warnings: ['Warning: plugin "diffs" is referenced by Claw: @acme/review.'],
      });
    },
  );

  it("refuses to uninstall bundled plugins", async () => {
    mocks.readConfig.mockResolvedValue(configSnapshot());
    mocks.installRecords.mockResolvedValue({});
    mocks.metadata.mockReturnValue(metadataSnapshot({ enabled: false }));

    await expect(uninstallManagedPlugin({ pluginId: "workboard", env: {} })).rejects.toThrow(
      "bundled plugin cannot be uninstalled",
    );
    expect([mocks.commitRecords.mock.calls, mocks.applyUninstall.mock.calls]).toEqual([[], []]);
  });

  it("surfaces uninstall plan failures as lifecycle errors", async () => {
    mocks.readConfig.mockResolvedValue(configSnapshot());
    mocks.installRecords.mockResolvedValue({});
    mocks.metadata.mockReturnValue(emptyMetadataSnapshot());
    mocks.planUninstall.mockReturnValue({ ok: false, error: "Plugin not found: ghost" });

    await expect(uninstallManagedPlugin({ pluginId: "ghost", env: {} })).rejects.toThrow(
      "Plugin not found: ghost",
    );
    expect(mocks.commitRecords).not.toHaveBeenCalled();
  });
});

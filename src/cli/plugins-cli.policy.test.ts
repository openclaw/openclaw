// Plugins CLI policy tests cover plugin command policy checks and warnings.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { buildPluginCapabilityConsentReview } from "../plugins/capability-summary.js";
import { recordInstalledPluginIndexInstallOwner } from "../plugins/installed-plugin-index-install-owner.js";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import {
  createPluginManifestRecordFixture,
  createPluginMetadataSnapshotFixture,
} from "../plugins/plugin-metadata.test-support.js";
import { createColdPluginFixture } from "../plugins/test-helpers/cold-plugin-fixtures.js";
import { withEnvAsync } from "../test-utils/env.js";
import { withTempDir } from "../test-utils/temp-dir.js";
import {
  applyExclusiveSlotSelectionMock,
  enablePluginInConfigMock,
  resolvePluginLifecycleGatewayMock,
  pluginLifecycleGatewayMock,
  loadPluginManifestRegistryMock,
  loadPluginMetadataSnapshotMock,
  pluginCliConfigMock,
  replaceConfigFileMock,
  refreshPluginRegistryMock,
  resetPluginsCliTestState,
  runtimeErrors,
  pluginsCliRuntimeLogs,
  promptYesNoMock,
  runPluginsCommand,
  setInstalledPluginIndexInstallRecords,
  configWriteMock,
  writePersistedInstalledPluginIndexInstallRecordsWithLeaseMock,
} from "./plugins-cli-test-helpers.js";
import { createCliTtyMock } from "./test-runtime-capture.js";

const inventory = vi.hoisted(() => ({ load: vi.fn(), hostedCatalog: vi.fn() }));

vi.mock("../plugins/plugin-registry-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/plugin-registry-snapshot.js")>()),
  loadPluginRegistrySnapshotWithMetadata: (...args: unknown[]) => inventory.load(...args),
}));

vi.mock("../plugins/official-external-plugin-catalog.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/official-external-plugin-catalog.js")>()),
  loadConfiguredHostedOfficialExternalPluginCatalogEntries: (...args: unknown[]) =>
    inventory.hostedCatalog(...args),
}));

const ORIGINAL_OPENCLAW_NIX_MODE = process.env.OPENCLAW_NIX_MODE;

describe("plugins cli policy mutations", () => {
  let readInstallRecords: (typeof import("../plugins/installed-plugin-index-record-reader.js"))["loadInstalledPluginIndexInstallRecordsSync"];

  beforeEach(async () => {
    resetPluginsCliTestState();
    // Policy cases derive metadata from their config-sensitive registry fixture;
    // the shared install-output snapshot assumes synthetic enabled artifacts.
    const metadata = await vi.importActual<typeof import("../plugins/plugin-metadata-snapshot.js")>(
      "../plugins/plugin-metadata-snapshot.js",
    );
    loadPluginMetadataSnapshotMock.mockImplementation(metadata.loadPluginMetadataSnapshot);
    // Resolve after the shared CLI fixture registers its record-IO mock.
    ({ loadInstalledPluginIndexInstallRecordsSync: readInstallRecords } =
      await import("../plugins/installed-plugin-index-record-reader.js"));
    clearPluginMetadataLifecycleCaches();
    inventory.load.mockReset();
    inventory.hostedCatalog.mockReset();
    inventory.hostedCatalog.mockRejectedValue(
      new Error("Toggle must not fetch the hosted catalog"),
    );
    const enable =
      await vi.importActual<typeof import("../plugins/enable.js")>("../plugins/enable.js");
    const slots =
      await vi.importActual<typeof import("../plugins/slots.js")>("../plugins/slots.js");
    enablePluginInConfigMock.mockImplementation((config, pluginId, options) =>
      enable.enableExplicitlySelectedPluginInConfig(
        config as OpenClawConfig,
        pluginId as string,
        options as Parameters<typeof enable.enableExplicitlySelectedPluginInConfig>[2],
      ),
    );
    applyExclusiveSlotSelectionMock.mockImplementation((params) =>
      slots.applyExclusiveSlotSelection(
        params as Parameters<typeof slots.applyExclusiveSlotSelection>[0],
      ),
    );
    mockPluginRegistry([]);
  });

  afterEach(() => {
    expect(inventory.hostedCatalog).not.toHaveBeenCalled();
    clearPluginMetadataLifecycleCaches();
    if (ORIGINAL_OPENCLAW_NIX_MODE === undefined) {
      delete process.env.OPENCLAW_NIX_MODE;
    } else {
      process.env.OPENCLAW_NIX_MODE = ORIGINAL_OPENCLAW_NIX_MODE;
    }
  });

  function mockPluginRegistry(ids: string[]) {
    inventory.load.mockImplementation(({ config }: { config: OpenClawConfig }) => {
      const installRecords = readInstallRecords();
      const installedManifests = loadPluginManifestRegistryMock({
        installRecords,
      }) as PluginManifestRegistry;
      const plugins = ids.map(
        (id) =>
          installedManifests.plugins.find((plugin) => plugin.id === id) ??
          createPluginManifestRecordFixture({ id, rootDir: `/tmp/bundled-${id}` }),
      );
      const { index } = createPluginMetadataSnapshotFixture({ plugins });
      index.policyHash = JSON.stringify(config.plugins ?? {});
      index.installRecords = installRecords;
      for (const record of index.plugins) {
        record.enabled = config.plugins?.entries?.[record.pluginId]?.enabled ?? false;
        recordInstalledPluginIndexInstallOwner(
          record,
          Object.hasOwn(installRecords, record.pluginId) ? record.pluginId : undefined,
        );
      }
      return {
        source: "derived",
        diagnostics: [],
        manifestRegistry: { plugins, diagnostics: [] },
        snapshot: index,
      };
    });
  }

  function requireFirstWrittenConfig(): OpenClawConfig {
    return configWriteMock.mock.calls[0]![0]!;
  }

  function mockCurrentConfig(initial: OpenClawConfig = {}) {
    pluginCliConfigMock.mockImplementation(
      () => replaceConfigFileMock.mock.calls.at(-1)?.[0].sourceConfig ?? initial,
    );
  }

  it.each([
    { command: "enable", ids: ["beta", "alpha"], acceptCapabilities: true },
    { command: "disable", ids: ["beta", "alpha", "beta"], acceptCapabilities: false },
  ])(
    "applies online $command for $ids through the running owner without a local config write",
    async ({ command, ids, acceptCapabilities }) => {
      resolvePluginLifecycleGatewayMock.mockResolvedValue(pluginLifecycleGatewayMock);
      for (const id of ids) {
        pluginLifecycleGatewayMock.mockImplementationOnce(async (...args: unknown[]) => {
          if (acceptCapabilities) {
            const consent = args[2];
            if (typeof consent !== "function") {
              throw new Error("Expected capability consent");
            }
            const review = buildPluginCapabilityConsentReview({
              pluginId: id,
              manifest: { name: id, hooks: ["agent:bootstrap"] },
              record: { source: "npm", spec: `@acme/${id}` },
              config: {},
            });
            expect(await consent(review)).toEqual({ reviewToken: review.reviewToken });
          }
          return { plugin: { id }, runtime: { generation: 2 } };
        });
      }
      await runPluginsCommand([
        "plugins",
        command,
        ...ids,
        ...(acceptCapabilities ? ["--accept-capabilities"] : []),
      ]);
      expect(pluginLifecycleGatewayMock.mock.calls.map((call) => call.slice(0, 2))).toEqual(
        ids.map((id) => [
          "plugins.setEnabled",
          {
            pluginId: id,
            enabled: command === "enable",
            ...(command === "enable" ? { allowlistPolicy: "preserve" } : {}),
          },
        ]),
      );
      expect(resolvePluginLifecycleGatewayMock).toHaveBeenCalledTimes(ids.length);
      expect(configWriteMock).not.toHaveBeenCalled();
      expect(enablePluginInConfigMock).not.toHaveBeenCalled();
    },
  );

  it.each([
    { mode: undefined, json: false, acceptCapabilities: true, ids: ["alpha"], wait: true },
    {
      mode: undefined,
      json: false,
      acceptCapabilities: true,
      ids: ["alpha"],
      restartRequired: true,
    },
    {
      mode: "OPENCLAW_CONFIG_READONLY",
      json: false,
      acceptCapabilities: true,
      ids: ["alpha", "beta"],
    },
    { mode: undefined, json: true, acceptCapabilities: false, ids: ["alpha", "beta"] },
    { mode: undefined, json: true, acceptCapabilities: true, ids: ["alpha", "beta"] },
  ])(
    "reloads CLI-selected $ids in one generation (mode=$mode, json=$json, accept=$acceptCapabilities)",
    async ({ mode, json, acceptCapabilities, ids, restartRequired = false, wait = false }) => {
      resolvePluginLifecycleGatewayMock.mockResolvedValue(pluginLifecycleGatewayMock);
      const receipt = {
        ok: true,
        pluginIds: ids,
        restartRequired,
        runtime: {
          operationId: "reload-selected",
          generation: 2,
          pluginIds: ids,
          selectedEntries: Object.fromEntries(
            ids.map((id) => [id, `/plugins/${id}/dist/index.js`]),
          ),
        },
      };
      const review = buildPluginCapabilityConsentReview({
        pluginId: "alpha",
        manifest: { name: "Alpha", hooks: ["agent:bootstrap"] },
        record: { source: "npm", spec: "@acme/alpha" },
        config: {},
      });
      const consentRequired = new Error("Plugin alpha requires capability consent.");
      pluginLifecycleGatewayMock.mockImplementation(async (...args: unknown[]) => {
        if (json) {
          const consent = args[2];
          if (typeof consent !== "function") {
            throw consentRequired;
          }
          expect(await consent(review)).toEqual({ reviewToken: review.reviewToken });
        }
        return receipt;
      });
      const tty = createCliTtyMock();
      try {
        tty.set(true);
        await withEnvAsync(mode ? { [mode]: "1" } : {}, async () => {
          const reload = runPluginsCommand([
            "plugins",
            "reload",
            ...ids,
            "alpha",
            ...(json ? ["--json"] : []),
            ...(wait ? ["--wait"] : []),
            ...(acceptCapabilities ? ["--accept-capabilities"] : []),
          ]);
          if (json && !acceptCapabilities) {
            await expect(reload).rejects.toBe(consentRequired);
          } else {
            await reload;
          }
        });
      } finally {
        tty.restore();
      }
      expect(pluginLifecycleGatewayMock).toHaveBeenCalledExactlyOnceWith(
        "plugins.reload",
        { plugins: ids.map((pluginId) => ({ pluginId })), ...(wait ? { waitForDrain: true } : {}) },
        acceptCapabilities ? expect.any(Function) : undefined,
      );
      expect(promptYesNoMock).not.toHaveBeenCalled();
      if (json) {
        if (acceptCapabilities) {
          expect(JSON.parse(pluginsCliRuntimeLogs.join("\n"))).toEqual(receipt);
        } else {
          expect(pluginsCliRuntimeLogs).toEqual([]);
        }
      } else {
        for (const id of ids) {
          expect(pluginsCliRuntimeLogs).toContain(
            `${id}: Selected entry: /plugins/${id}/dist/index.js. Rebuild compiled output after source edits.`,
          );
        }
        expect(pluginsCliRuntimeLogs).toContain(
          restartRequired
            ? 'Reloaded registrations for plugin "alpha" (generation 2). Gateway restart required to load edited code.'
            : ids.length === 1
              ? 'Reloaded plugin "alpha" (generation 2).'
              : 'Reloaded plugins "alpha", "beta" (generation 2).',
        );
      }
      expect(configWriteMock).not.toHaveBeenCalled();
    },
  );

  it("refuses offline reload without modifying config or dispatching a mutation", async () => {
    resolvePluginLifecycleGatewayMock.mockResolvedValue(null);
    await expect(runPluginsCommand(["plugins", "reload", "alpha"])).rejects.toThrow(
      "The Gateway is not running. Start it before reloading a plugin.",
    );
    expect(pluginLifecycleGatewayMock).not.toHaveBeenCalled();
    expect(configWriteMock).not.toHaveBeenCalled();
  });

  it.each(["enable", "disable"])(
    "applies %s in order using the previously committed config",
    async (command) => {
      const enabled = command === "enable";
      mockCurrentConfig({
        plugins: { entries: { alpha: { enabled: !enabled }, beta: { enabled: !enabled } } },
      });
      mockPluginRegistry(["alpha", "beta"]);

      await runPluginsCommand(["plugins", command, "beta", "alpha"]);

      expect(configWriteMock.mock.calls).toEqual([
        [{ plugins: { entries: { alpha: { enabled: !enabled }, beta: { enabled } } } }],
        [{ plugins: { entries: { alpha: { enabled }, beta: { enabled } } } }],
      ]);
      expect(refreshPluginRegistryMock).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ policyPluginIds: ["beta"] }),
      );
      expect(refreshPluginRegistryMock).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ policyPluginIds: ["alpha"] }),
      );
    },
  );

  it("toggles mixed-case manifest ids using their canonical policy key", async () => {
    mockCurrentConfig({
      plugins: {
        entries: { "MiXeD-demo": { enabled: true, config: { label: "keep" } } },
      },
    });
    mockPluginRegistry(["MiXeD-demo"]);

    await runPluginsCommand(["plugins", "disable", "MiXeD-demo"]);
    await runPluginsCommand(["plugins", "enable", "mixed-demo"]);

    expect(configWriteMock.mock.calls).toEqual([
      [{ plugins: { entries: { "mixed-demo": { enabled: false, config: { label: "keep" } } } } }],
      [{ plugins: { entries: { "mixed-demo": { enabled: true, config: { label: "keep" } } } } }],
    ]);
    expect(refreshPluginRegistryMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ policyPluginIds: ["mixed-demo"] }),
    );
    expect(refreshPluginRegistryMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ policyPluginIds: ["mixed-demo"] }),
    );
    expect(runtimeErrors).toEqual([]);
  });

  it.each(["missing", "blocked"])(
    "stops at a %s plugin while retaining earlier enables",
    async (failure) => {
      mockCurrentConfig({
        plugins: {
          ...(failure === "blocked" ? { deny: ["beta"] } : {}),
          entries: {
            alpha: { enabled: false },
            beta: { enabled: false },
            gamma: { enabled: false },
          },
        },
      });
      mockPluginRegistry(failure === "missing" ? ["alpha", "gamma"] : ["alpha", "beta", "gamma"]);

      await expect(
        runPluginsCommand(["plugins", "enable", "alpha", "beta", "gamma"]),
      ).rejects.toThrow("__exit__:1");

      expect(configWriteMock).toHaveBeenCalledOnce();
      expect(requireFirstWrittenConfig().plugins?.entries).toEqual({
        alpha: { enabled: true },
        beta: { enabled: false },
        gamma: { enabled: false },
      });
      expect(refreshPluginRegistryMock).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ policyPluginIds: ["alpha"] }),
      );
      expect(runtimeErrors.at(-1)).toContain(
        failure === "missing"
          ? "Plugin not found: beta"
          : 'Plugin "beta" could not be enabled (blocked by denylist).',
      );
    },
  );

  it("stops at an unconsented installed plugin while retaining earlier enables", async () => {
    await withTempDir("openclaw-cli-capability-consent-", async (rootDir) => {
      createColdPluginFixture({ rootDir, pluginId: "alpha" });
      const sourceConfig = {
        plugins: { entries: { alpha: { enabled: false } } },
      } as OpenClawConfig;
      mockCurrentConfig(sourceConfig);
      setInstalledPluginIndexInstallRecords({
        alpha: { source: "npm", spec: "@acme/alpha", installPath: rootDir },
      });
      expect(readInstallRecords().alpha?.installPath).toBe(rootDir);
      mockPluginRegistry(["alpha", "beta", "gamma"]);
      await expect(
        runPluginsCommand(["plugins", "enable", "beta", "alpha", "gamma"]),
      ).rejects.toThrow("__exit__:1");

      expect(runtimeErrors.at(-1)).toContain("--accept-capabilities");
      expect(configWriteMock).toHaveBeenCalledOnce();
      expect(requireFirstWrittenConfig().plugins?.entries).toEqual({
        alpha: { enabled: false },
        beta: { enabled: true },
      });
      expect(writePersistedInstalledPluginIndexInstallRecordsWithLeaseMock).not.toHaveBeenCalled();
    });
  });

  it("refuses plugin enablement in Nix mode before config mutation", async () => {
    process.env.OPENCLAW_NIX_MODE = "1";
    await expect(runPluginsCommand(["plugins", "enable", "alpha"])).rejects.toThrow(
      "OPENCLAW_NIX_MODE=1",
    );

    expect(configWriteMock).not.toHaveBeenCalled();
  });
});

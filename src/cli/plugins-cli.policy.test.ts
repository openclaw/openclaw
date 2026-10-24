import { afterEach, beforeEach, expect, it, vi } from "vitest";
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
  resolvePluginLifecycleGatewayMock as resolveGateway,
  pluginLifecycleGatewayMock as gateway,
  loadPluginManifestRegistryMock,
  loadPluginMetadataSnapshotMock,
  pluginCliConfigMock as configMock,
  replaceConfigFileMock,
  refreshPluginRegistryMock as refreshRegistry,
  resetPluginsCliTestState,
  runtimeErrors,
  pluginsCliRuntimeLogs as logs,
  promptYesNoMock,
  runPluginCli,
  expectNoPluginCliCalls as expectNoCalls,
  setInstalledPluginIndexInstallRecords,
  configWriteMock,
  writePersistedInstalledPluginIndexInstallRecordsWithLeaseMock as writeInstallRecords,
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

function consentReview(id: string, name = id) {
  return buildPluginCapabilityConsentReview({
    pluginId: id,
    manifest: { name, hooks: ["agent:bootstrap"] },
    record: { source: "npm", spec: `@acme/${id}` },
    config: {},
  });
}
function pluginConfig(entries: NonNullable<OpenClawConfig["plugins"]>["entries"]): OpenClawConfig {
  return { plugins: { entries } };
}
function disabled(...ids: string[]) {
  return Object.fromEntries(ids.map((id) => [id, { enabled: false }]));
}
function expectRefreshes(...ids: string[]) {
  ids.forEach((id, index) =>
    expect(refreshRegistry).toHaveBeenNthCalledWith(
      index + 1,
      expect.objectContaining({ policyPluginIds: [id] }),
    ),
  );
}

let readInstallRecords: (typeof import("../plugins/installed-plugin-index-record-reader.js"))["loadInstalledPluginIndexInstallRecordsSync"];

beforeEach(async () => {
  resetPluginsCliTestState();
  // Derive metadata from the config-sensitive registry, not the shared enabled-artifact snapshot.
  const metadata = await vi.importActual<typeof import("../plugins/plugin-metadata-snapshot.js")>(
    "../plugins/plugin-metadata-snapshot.js",
  );
  loadPluginMetadataSnapshotMock.mockImplementation(metadata.loadPluginMetadataSnapshot);
  ({ loadInstalledPluginIndexInstallRecordsSync: readInstallRecords } =
    await import("../plugins/installed-plugin-index-record-reader.js"));
  clearPluginMetadataLifecycleCaches();
  inventory.load.mockReset();
  inventory.hostedCatalog
    .mockReset()
    .mockRejectedValue(new Error("Unexpected hosted catalog fetch"));
  const enable =
    await vi.importActual<typeof import("../plugins/enable.js")>("../plugins/enable.js");
  const slots = await vi.importActual<typeof import("../plugins/slots.js")>("../plugins/slots.js");
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

function mockCurrentConfig(initial: OpenClawConfig = {}) {
  configMock.mockImplementation(
    () => replaceConfigFileMock.mock.calls.at(-1)?.[0].sourceConfig ?? initial,
  );
}

it.each([
  { command: "enable", ids: ["beta", "alpha"], acceptCapabilities: true },
  { command: "disable", ids: ["beta", "alpha", "beta"], acceptCapabilities: false },
])(
  "applies online $command for $ids through the running owner without a local config write",
  async ({ command, ids, acceptCapabilities }) => {
    resolveGateway.mockResolvedValue(gateway);
    for (const id of ids) {
      gateway.mockImplementationOnce(async (...args: unknown[]) => {
        if (acceptCapabilities) {
          const consent = args[2];
          if (typeof consent !== "function") {
            throw new Error("Expected capability consent");
          }
          const review = consentReview(id);
          expect(await consent(review)).toEqual({ reviewToken: review.reviewToken });
        }
        return { plugin: { id }, runtime: { generation: 2 } };
      });
    }
    await runPluginCli(command, ...ids, ...(acceptCapabilities ? ["--accept-capabilities"] : []));
    expect(gateway.mock.calls.map((call) => call.slice(0, 2))).toEqual(
      ids.map((id) => [
        "plugins.setEnabled",
        {
          pluginId: id,
          enabled: command === "enable",
          ...(command === "enable" ? { allowlistPolicy: "preserve" } : {}),
        },
      ]),
    );
    expect(resolveGateway).toHaveBeenCalledTimes(ids.length);
    expectNoCalls(configWriteMock, enablePluginInConfigMock);
  },
);

it.each([
  { mode: undefined, json: false, acceptCapabilities: true, ids: ["alpha"], wait: true },
  { ids: ["alpha"], restartRequired: true },
  { mode: "OPENCLAW_CONFIG_READONLY", ids: ["alpha", "beta"] },
  { mode: undefined, json: true, acceptCapabilities: false, ids: ["alpha", "beta"] },
  { mode: undefined, json: true, acceptCapabilities: true, ids: ["alpha", "beta"] },
])(
  "reloads CLI-selected $ids in one generation (mode=$mode, json=$json, accept=$acceptCapabilities)",
  async ({
    mode,
    json = false,
    acceptCapabilities = true,
    ids,
    restartRequired = false,
    wait = false,
  }) => {
    resolveGateway.mockResolvedValue(gateway);
    const receipt = {
      ok: true,
      pluginIds: ids,
      restartRequired,
      runtime: {
        operationId: "reload-selected",
        generation: 2,
        pluginIds: ids,
        selectedEntries: Object.fromEntries(ids.map((id) => [id, `/plugins/${id}/dist/index.js`])),
      },
    };
    const review = consentReview("alpha", "Alpha");
    const consentRequired = new Error("Plugin alpha requires capability consent.");
    gateway.mockImplementation(async (...args: unknown[]) => {
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
        const reload = runPluginCli(
          "reload",
          ...ids,
          "alpha",
          ...(json ? ["--json"] : []),
          ...(wait ? ["--wait"] : []),
          ...(acceptCapabilities ? ["--accept-capabilities"] : []),
        );
        if (json && !acceptCapabilities) {
          await expect(reload).rejects.toBe(consentRequired);
        } else {
          await reload;
        }
      });
    } finally {
      tty.restore();
    }
    expect(gateway).toHaveBeenCalledExactlyOnceWith(
      "plugins.reload",
      { plugins: ids.map((pluginId) => ({ pluginId })), ...(wait ? { waitForDrain: true } : {}) },
      acceptCapabilities ? expect.any(Function) : undefined,
    );
    expect(promptYesNoMock).not.toHaveBeenCalled();
    if (json) {
      if (acceptCapabilities) {
        expect(JSON.parse(logs.join("\n"))).toEqual(receipt);
      } else {
        expect(logs).toEqual([]);
      }
    } else {
      for (const id of ids) {
        expect(logs).toContain(
          `${id}: Selected entry: /plugins/${id}/dist/index.js. Rebuild compiled output after source edits.`,
        );
      }
      expect(logs).toContain(
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
  resolveGateway.mockResolvedValue(null);
  await expect(runPluginCli("reload", "alpha")).rejects.toThrow(
    "The Gateway is not running. Start it before reloading a plugin.",
  );
  expectNoCalls(gateway, configWriteMock);
});

it("applies enable in order using the previously committed config", async () => {
  mockCurrentConfig(pluginConfig(disabled("alpha", "beta")));
  mockPluginRegistry(["alpha", "beta"]);

  await runPluginCli("enable", "beta", "alpha");

  expect(configWriteMock.mock.calls).toEqual([
    [pluginConfig({ alpha: { enabled: false }, beta: { enabled: true } })],
    [pluginConfig({ alpha: { enabled: true }, beta: { enabled: true } })],
  ]);
  expectRefreshes("beta", "alpha");
});

it("toggles mixed-case manifest ids using their canonical policy key", async () => {
  const entry = { config: { label: "keep" } };
  mockCurrentConfig(pluginConfig({ "MiXeD-demo": { ...entry, enabled: true } }));
  mockPluginRegistry(["MiXeD-demo"]);

  await runPluginCli("disable", "MiXeD-demo");
  await runPluginCli("enable", "mixed-demo");

  expect(configWriteMock.mock.calls).toEqual([
    [pluginConfig({ "mixed-demo": { ...entry, enabled: false } })],
    [pluginConfig({ "mixed-demo": { ...entry, enabled: true } })],
  ]);
  expectRefreshes("mixed-demo", "mixed-demo");
  expect(runtimeErrors).toEqual([]);
});

it.each(["missing", "blocked", "unconsented"])(
  "stops at a %s plugin while retaining earlier enables",
  async (failure) => {
    const check = async (rootDir: string) => {
      const consent = failure === "unconsented";
      if (consent) {
        createColdPluginFixture({ rootDir, pluginId: "alpha" });
        setInstalledPluginIndexInstallRecords({
          alpha: { source: "npm", spec: "@acme/alpha", installPath: rootDir },
        });
        expect(readInstallRecords().alpha?.installPath).toBe(rootDir);
      }
      const entries = consent ? disabled("alpha") : disabled("alpha", "beta", "gamma");
      mockCurrentConfig({
        plugins: { entries, ...(failure === "blocked" ? { deny: ["beta"] } : {}) },
      });
      mockPluginRegistry(failure === "missing" ? ["alpha", "gamma"] : ["alpha", "beta", "gamma"]);
      const first = consent ? "beta" : "alpha";
      await expect(
        runPluginCli("enable", first, consent ? "alpha" : "beta", "gamma"),
      ).rejects.toThrow("__exit__:1");
      expect(configWriteMock).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          plugins: expect.objectContaining({
            entries: {
              ...(consent ? disabled("alpha") : disabled("alpha", "beta", "gamma")),
              [first]: { enabled: true },
            },
          }),
        }),
      );
      if (consent) {
        expect(writeInstallRecords).not.toHaveBeenCalled();
      } else {
        expect(refreshRegistry).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ policyPluginIds: [first] }),
        );
      }
      expect(runtimeErrors.at(-1)).toContain(
        consent
          ? "--accept-capabilities"
          : failure === "missing"
            ? "Plugin not found: beta"
            : 'Plugin "beta" could not be enabled (blocked by denylist).',
      );
    };
    await (failure === "unconsented"
      ? withTempDir("openclaw-cli-capability-consent-", check)
      : check(""));
  },
);

it("refuses plugin enablement in Nix mode before config mutation", async () => {
  await withEnvAsync({ OPENCLAW_NIX_MODE: "1" }, async () => {
    await expect(runPluginCli("enable", "alpha")).rejects.toThrow("OPENCLAW_NIX_MODE=1");
  });

  expect(configWriteMock).not.toHaveBeenCalled();
});

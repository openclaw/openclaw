import os from "node:os";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { pluginLifecycleError } from "../gateway/server-methods/plugins-lifecycle-error.js";
import { buildPluginCapabilitySummary, computeDeclaredSurfaceHash } from "./capability-summary.js";
import { PluginInstallConfigError } from "./install-config.js";
import {
  configSnapshot,
  hostedFeedDiffsEntry,
  metadataSnapshot,
} from "./management-service.test-helpers.js";
import { invokePluginArtifactInstallMock } from "./test-helpers/install-fixtures.js";

const mocks = vi.hoisted(() => ({
  clawhubInstall: vi.fn(),
  installRecords: vi.fn(),
  metadata: vi.fn(),
  npmInstall: vi.fn(),
  officialCatalog: vi.fn(),
  persistInstall: vi.fn(),
  preflight: vi.fn(),
  readConfig: vi.fn(),
  refreshRegistry: vi.fn(),
  replaceConfig: vi.fn(),
  selectWriteOptions: vi.fn((writeOptions: unknown) => writeOptions),
  slotSelection: vi.fn((config: unknown) => config),
}));

vi.mock("../config/config.js", () => ({
  assertConfigWriteAllowedInCurrentMode: (params?: { env?: NodeJS.ProcessEnv }) => {
    if (params?.env?.OPENCLAW_NIX_MODE === "1") {
      throw new Error("Config is managed by Nix");
    }
  },
  readConfigFileSnapshotForWrite: () => mocks.readConfig(),
  replaceConfigFile: (params: unknown) => mocks.replaceConfig(params),
}));

vi.mock("./install-persistence.js", () => ({
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
  installPluginFromClawHub: (params: Parameters<typeof invokePluginArtifactInstallMock>[1]) =>
    invokePluginArtifactInstallMock(mocks.clawhubInstall, params, {
      manifest: { providers: [], channels: [], channelConfigs: {}, providerAuthChoices: [] },
    }),
}));

vi.mock("./install.js", () => ({
  installPluginFromNpmSpec: (params: Parameters<typeof invokePluginArtifactInstallMock>[1]) =>
    invokePluginArtifactInstallMock(mocks.npmInstall, params, {
      manifest: { providers: [], channels: [], channelConfigs: {}, providerAuthChoices: [] },
    }),
}));

vi.mock("./installed-plugin-index-records.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./installed-plugin-index-records.js")>()),
  loadInstalledPluginIndexInstallRecords: (...args: unknown[]) => mocks.installRecords(...args),
}));

vi.mock("./official-external-plugin-catalog.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./official-external-plugin-catalog.js")>()),
  loadConfiguredHostedOfficialExternalPluginCatalogEntries: (...args: unknown[]) =>
    mocks.officialCatalog(...args),
}));

const { clearManagedPluginCatalogCache } = await import("./management-catalog.js");
const { installManagedPlugin, setManagedPluginEnabled } = await import("./management-mutations.js");

function mockHostedOfficialCatalog(entries: unknown[]) {
  mocks.officialCatalog.mockResolvedValue({
    source: "hosted",
    entries,
    feed: { schemaVersion: 1, id: "test", generatedAt: "now", sequence: 1, entries: [] },
    metadata: { url: "https://clawhub.ai/feed", status: 200, checksum: "hash" },
  });
}

const emptyArtifactAcknowledgment = {
  reviewToken: computeDeclaredSurfaceHash(
    buildPluginCapabilitySummary({ manifest: {}, origin: "global" }).declared,
  ),
};

function mockClawHubInstall(pluginId: string, packageName: string) {
  const result = {
    ok: true,
    pluginId,
    targetDir: `/tmp/extensions/${pluginId}`,
    extensions: ["index.js"],
    packageName,
    clawhub: {
      source: "clawhub",
      clawhubUrl: "https://clawhub.ai",
      clawhubPackage: packageName,
      clawhubFamily: "code-plugin",
    },
  };
  mocks.clawhubInstall.mockResolvedValue(result);
  return result;
}

describe("managed plugin installation", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  beforeEach(() => {
    // Explicit empty env fixtures must never acquire a lease in the operator's home.
    vi.spyOn(os, "homedir").mockReturnValue(tempDirs.make("openclaw-managed-install-home-"));
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
    mocks.readConfig.mockResolvedValue(configSnapshot());
    mocks.persistInstall.mockResolvedValue({});
    mockHostedOfficialCatalog([]);
  });

  afterEach(() => vi.restoreAllMocks());

  it("refuses managed installs in Nix mode before config or artifact work", async () => {
    mocks.npmInstall.mockResolvedValue({ ok: false, error: "artifact installer reached" });
    mocks.clawhubInstall.mockResolvedValue({ ok: false, error: "artifact installer reached" });
    await expect(
      installManagedPlugin({
        request: { source: "official", pluginId: "diffs" },
        env: { OPENCLAW_NIX_MODE: "1" },
      }),
    ).rejects.toThrow("Config is managed by Nix");
    expect(mocks.readConfig).not.toHaveBeenCalled();
    expect(mocks.clawhubInstall).not.toHaveBeenCalled();
    expect(mocks.npmInstall).not.toHaveBeenCalled();
    expect(mocks.persistInstall).not.toHaveBeenCalled();
  });

  it("does not apply public feed integrity to a custom ClawHub registry", async () => {
    mockHostedOfficialCatalog([hostedFeedDiffsEntry]);
    mockClawHubInstall("diffs", "@openclaw/diffs");
    mocks.metadata.mockReturnValue(
      metadataSnapshot({ enabled: true, id: "diffs", name: "Diffs", origin: "global" }),
    );

    await installManagedPlugin({
      request: {
        source: "clawhub",
        packageName: "@openclaw/diffs",
        acknowledgeCapabilities: emptyArtifactAcknowledgment,
      },
      env: { OPENCLAW_CLAWHUB_URL: "https://mirror.example.test" },
    });

    expect(mocks.officialCatalog).not.toHaveBeenCalled();
    expect(mocks.clawhubInstall).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedPluginId: "diffs",
      }),
    );
    expect(mocks.clawhubInstall).toHaveBeenCalledWith(
      expect.not.objectContaining({ expectedIntegrity: expect.anything() }),
    );
  });

  it.each([false, true])(
    "uses npm first and ClawHub only when npm is absent (%s)",
    async (absent) => {
      mocks.readConfig.mockResolvedValue(configSnapshot());
      mockHostedOfficialCatalog([
        {
          name: "@openclaw/diffs",
          openclaw: {
            plugin: { id: "diffs" },
            install: {
              npmSpec: "@openclaw/diffs",
              clawhubSpec: "clawhub:@openclaw/diffs",
              defaultChoice: "clawhub",
              expectedIntegrity: "sha512-npmpin",
            },
          },
        },
      ]);
      mocks.npmInstall.mockResolvedValue(
        absent
          ? { ok: false, code: "npm_package_not_found", error: "package absent" }
          : { ok: true, pluginId: "diffs", targetDir: "/tmp/npm/diffs", extensions: ["index.js"] },
      );
      mockClawHubInstall("diffs", "@openclaw/diffs");
      mocks.persistInstall.mockResolvedValue({});
      mocks.metadata.mockReturnValue(
        metadataSnapshot({ enabled: true, id: "diffs", name: "Diffs", origin: "global" }),
      );

      await installManagedPlugin({
        request: {
          source: "official",
          pluginId: "diffs",
          acknowledgeCapabilities: emptyArtifactAcknowledgment,
        },
        env: {},
      });

      expect(mocks.npmInstall).toHaveBeenCalledTimes(1);
      expect(mocks.npmInstall).toHaveBeenCalledWith(
        expect.objectContaining({ expectedIntegrity: "sha512-npmpin" }),
      );
      expect(mocks.clawhubInstall).toHaveBeenCalledTimes(absent ? 1 : 0);
      if (absent) {
        expect(mocks.clawhubInstall.mock.calls[0]?.[0].expectedIntegrity).toBeUndefined();
      }
      expect(mocks.persistInstall).toHaveBeenCalledWith(
        expect.objectContaining({
          install: expect.objectContaining({ source: absent ? "clawhub" : "npm" }),
          runtimeMaintenance: {
            operation: "install",
            signal: expect.any(AbortSignal),
            assertCurrent: expect.any(Function),
          },
        }),
      );
    },
  );

  it.each([
    { code: "incompatible_plugin_api", error: "incompatible artifact" },
    { code: "security_scan_blocked", error: "untrusted package" },
    { code: "security_scan_failed", error: "policy failed" },
    { error: "integrity mismatch" },
  ])("never falls back after npm refusal ($error)", async (failure) => {
    mocks.readConfig.mockResolvedValue(configSnapshot());
    mockHostedOfficialCatalog([
      {
        name: "@openclaw/diffs",
        openclaw: {
          plugin: { id: "diffs" },
          install: { npmSpec: "@openclaw/diffs", clawhubSpec: "clawhub:@openclaw/diffs" },
        },
      },
    ]);
    mocks.npmInstall.mockResolvedValue({ ok: false, ...failure });
    const rejected = await installManagedPlugin({
      request: { source: "official", pluginId: "diffs" },
      env: {},
    }).catch((error: unknown) => error);
    expect(rejected).toMatchObject({ message: failure.error });
    const serialized = pluginLifecycleError(rejected, { entered: true });
    expect(serialized).toMatchObject({
      message: failure.error,
      details: {
        pluginInstallRejected: true,
        ...(failure.code ? { pluginInstallCode: failure.code } : {}),
        pluginInstallSource: { source: "npm" },
      },
    });
    if (!failure.code) {
      expect(serialized.details).not.toHaveProperty("pluginInstallCode");
    }
    expect(mocks.clawhubInstall).not.toHaveBeenCalled();
    expect(mocks.persistInstall).not.toHaveBeenCalled();
  });

  it.each([
    {
      valid: false,
      reason: "Config invalid; run `openclaw doctor --fix` before installing plugins.",
    },
    { valid: true, reason: "Plugin settings belong to an external include." },
  ])(
    "retains config refusal diagnostics without serializing the snapshot ($valid)",
    async ({ valid, reason }) => {
      const prepared = configSnapshot();
      prepared.snapshot.valid = valid;
      mocks.readConfig.mockResolvedValue(prepared);
      mocks.preflight.mockReturnValue({
        hookMutation: { mode: "allowed" },
        pluginMutation: { mode: "blocked", reason },
      });

      const rejected = await installManagedPlugin({
        request: { source: "npm", spec: "@acme/plugin" },
        env: {},
      }).catch((error: unknown) => error);
      expect(rejected).toMatchObject({
        message: reason,
        cause: expect.any(PluginInstallConfigError),
      });
      expect(pluginLifecycleError(rejected, { entered: true })).toEqual({
        code: "INVALID_REQUEST",
        message: `${reason} | INVALID_CONFIG`,
        details: {
          pluginInstallRejected: true,
          pluginInstallCode: "config_mutation_blocked",
        },
      });
      expect(mocks.npmInstall).not.toHaveBeenCalled();
      expect(mocks.clawhubInstall).not.toHaveBeenCalled();
      expect(mocks.persistInstall).not.toHaveBeenCalled();
    },
  );

  it("keeps each hosted source's exact version and integrity on fallback", async () => {
    mockHostedOfficialCatalog([
      {
        ...hostedFeedDiffsEntry,
        install: {
          candidates: [
            ...hostedFeedDiffsEntry.install.candidates,
            {
              sourceRef: "public-npm",
              package: "@openclaw/diffs",
              version: "2026.6.11",
              integrity: "sha512-test",
            },
          ],
        },
      },
    ]);
    mocks.npmInstall.mockResolvedValue({
      ok: false,
      code: "npm_package_not_found",
      error: "package absent",
    });
    mockClawHubInstall("diffs", "@openclaw/diffs");
    mocks.metadata.mockReturnValue(
      metadataSnapshot({ enabled: true, id: "diffs", origin: "global" }),
    );
    await installManagedPlugin({
      request: {
        source: "official",
        pluginId: "diffs",
        acknowledgeCapabilities: emptyArtifactAcknowledgment,
      },
      env: {},
    });
    expect(mocks.npmInstall).toHaveBeenCalledWith(
      expect.objectContaining({
        spec: "@openclaw/diffs@2026.6.11",
        expectedIntegrity: "sha512-test",
      }),
    );
    expect(mocks.clawhubInstall).toHaveBeenCalledWith(
      expect.objectContaining({
        spec: "clawhub:@openclaw/diffs@2026.6.11",
        expectedIntegrity: `sha256-${Buffer.from("a".repeat(64), "hex").toString("base64")}`,
      }),
    );
  });

  it("resolves hosted-only beta installs without pinning the package name as a runtime id", async () => {
    const installRecord = {
      source: "clawhub",
      spec: "clawhub:@openclaw/bluebubbles",
      installPath: "/tmp/extensions/bluebubbles",
    };
    mocks.readConfig.mockResolvedValue(configSnapshot({ update: { channel: "beta" } }));
    // Package identity without a declared runtime id must not become an expectedPluginId pin.
    mockHostedOfficialCatalog([
      {
        id: "@openclaw/bluebubbles",
        title: "BlueBubbles",
        state: "available",
        publisher: { id: "openclaw", trust: "official" },
        install: {
          candidates: [{ sourceRef: "public-clawhub", package: "@openclaw/bluebubbles" }],
        },
      },
    ]);
    mockClawHubInstall("bluebubbles", "@openclaw/bluebubbles");
    mocks.refreshRegistry.mockResolvedValue(undefined);
    mocks.metadata.mockReturnValue(
      metadataSnapshot({
        enabled: false,
        id: "bluebubbles",
        name: "BlueBubbles",
        origin: "global",
        installRecord,
      }),
    );

    const result = await installManagedPlugin({
      request: {
        source: "clawhub",
        packageName: "@openclaw/bluebubbles",
        acknowledgeCapabilities: emptyArtifactAcknowledgment,
      },
      env: {},
    });

    expect(mocks.clawhubInstall).toHaveBeenCalledWith(
      expect.not.objectContaining({ expectedPluginId: expect.anything() }),
    );
    expect(mocks.clawhubInstall).toHaveBeenCalledWith(
      expect.objectContaining({ spec: "clawhub:@openclaw/bluebubbles@beta" }),
    );
    expect(mocks.persistInstall).toHaveBeenCalledWith(
      expect.objectContaining({
        install: expect.objectContaining({ spec: "clawhub:@openclaw/bluebubbles" }),
      }),
    );
    expect(result.plugin.id).toBe("bluebubbles");
  });

  it("keeps the runtime-id pin when a declared id equals the package name", async () => {
    // An unscoped package can legitimately declare its package name as the runtime id.
    mockHostedOfficialCatalog([
      {
        id: "sonos",
        title: "Sonos",
        state: "available",
        publisher: { id: "openclaw", trust: "official" },
        openclaw: { plugin: { id: "sonos" } },
        install: { candidates: [{ sourceRef: "public-clawhub", package: "sonos" }] },
      },
    ]);
    mockClawHubInstall("impostor", "sonos");

    await expect(
      installManagedPlugin({
        request: { source: "clawhub", packageName: "sonos" },
        env: {},
      }),
    ).rejects.toThrow("expected sonos, got impostor");
    expect(mocks.clawhubInstall).toHaveBeenCalledWith(
      expect.objectContaining({ expectedPluginId: "sonos" }),
    );
  });

  it("approves every install-policy warning in an acknowledged Gateway install", async () => {
    mockHostedOfficialCatalog([hostedFeedDiffsEntry]);
    const installed = mockClawHubInstall("diffs", "@openclaw/diffs");
    mocks.clawhubInstall.mockImplementation(async (params: unknown) => {
      const callback = expectDefined(
        (
          params as {
            onInstallPolicyWarning?: (request: {
              targetName: string;
              targetType: "plugin";
              requestMode: "install";
              reason: string;
            }) => Promise<{ status: "approved" | "declined" }>;
          }
        ).onInstallPolicyWarning,
        "install policy acknowledgement callback",
      );
      for (const reason of ["Review package metadata", "Review installed dependencies"]) {
        await expect(
          callback({ targetName: "diffs", targetType: "plugin", requestMode: "install", reason }),
        ).resolves.toEqual({ status: "approved" });
      }
      return installed;
    });

    mocks.metadata.mockReturnValue(
      metadataSnapshot({ enabled: true, id: "diffs", name: "Diffs", origin: "global" }),
    );

    await installManagedPlugin({
      request: {
        source: "official",
        pluginId: "diffs",
        acknowledgeInstallPolicyWarning: true,
        acknowledgeCapabilities: emptyArtifactAcknowledgment,
      },
      env: {},
    });
  });

  it("serializes install and enable mutations through one Gateway lock", async () => {
    let releasePersist: ((config: Record<string, unknown>) => void) | undefined;
    const heldPersist = new Promise<Record<string, unknown>>((resolve) => {
      releasePersist = resolve;
    });
    mockClawHubInstall("demo", "community/demo");
    mocks.persistInstall.mockReturnValueOnce(heldPersist);
    mocks.replaceConfig.mockResolvedValue({});
    mocks.refreshRegistry.mockResolvedValue(undefined);
    mocks.metadata
      .mockReturnValueOnce(metadataSnapshot({ enabled: true, id: "demo", origin: "global" }))
      .mockReturnValueOnce(metadataSnapshot({ enabled: false }))
      .mockReturnValueOnce(metadataSnapshot({ enabled: true }));

    const install = installManagedPlugin({
      request: {
        source: "clawhub",
        packageName: "community/demo",
        acknowledgeCapabilities: emptyArtifactAcknowledgment,
      },
      env: {},
    });
    let enable: Promise<unknown> | undefined;
    try {
      await vi.waitFor(() => expect(mocks.persistInstall).toHaveBeenCalledTimes(1));
      enable = setManagedPluginEnabled({ pluginId: "workboard", enabled: true, env: {} });
      await Promise.resolve();
      expect(mocks.readConfig).toHaveBeenCalledTimes(1);
      releasePersist?.({});
      await install;
      await enable;
      expect(mocks.readConfig).toHaveBeenCalledTimes(2);
    } finally {
      releasePersist?.({});
      await Promise.allSettled([install, enable]);
    }
  });

  it("classifies unavailable ClawHub security checks", async () => {
    const code = "clawhub_security_unavailable";
    mocks.clawhubInstall.mockResolvedValue({
      ok: false,
      error: "ClawHub install failed",
      code,
      version: "1.2.3",
      warning: "Review the release",
    });

    await expect(
      installManagedPlugin({
        request: { source: "clawhub", packageName: "community/plugin" },
        env: {},
      }),
    ).rejects.toMatchObject({
      kind: "unavailable",
      code,
      version: "1.2.3",
      warning: "Review the release",
    });
  });
});

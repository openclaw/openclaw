import os from "node:os";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { pluginLifecycleError } from "../gateway/server-methods/plugins-lifecycle-error.js";
import { createDeferredCore } from "../shared/deferred.js";
import * as bundledSources from "./bundled-sources.js";
import { buildPluginCapabilitySummary, computeDeclaredSurfaceHash } from "./capability-summary.js";
import * as currentMetadata from "./current-plugin-metadata-state.js";
import { PluginInstallConfigError } from "./install-config.js";
import {
  configSnapshot,
  hostedFeedDiffsEntry,
  metadataSnapshot,
} from "./management-service.test-helpers.js";
import { managementMetadata } from "./management-service.test-support.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";
import { createColdPluginFixture } from "./test-helpers/cold-plugin-fixtures.js";
import { invokePluginArtifactInstallMock } from "./test-helpers/install-fixtures.js";

const mocks = vi.hoisted(() => {
  // Earlier shared-worker files can cache the real config-wide metadata reader.
  vi.resetModules();
  return {
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
  };
});

// A beta package version forces the beta update channel, so pin a stable host to keep
// the default stable-channel expectations independent of the checkout's release train.
vi.mock("../version.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../version.js")>()),
  VERSION: "2026.9.7",
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
  resolveInstallConfigMutationPreflights: mocks.preflight,
  selectInstallMutationWriteOptions: mocks.selectWriteOptions,
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

vi.mock("./install.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./install.js")>()),
  installPluginFromNpmSpec: (params: Parameters<typeof invokePluginArtifactInstallMock>[1]) =>
    invokePluginArtifactInstallMock(mocks.npmInstall, params, {
      manifest: { providers: [], channels: [], channelConfigs: {}, providerAuthChoices: [] },
    }),
}));

vi.mock("./installed-plugin-index-records.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./installed-plugin-index-records.js")>()),
  loadInstalledPluginIndexInstallRecords: mocks.installRecords,
}));

vi.mock("./official-external-plugin-catalog.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./official-external-plugin-catalog.js")>()),
  loadConfiguredHostedOfficialExternalPluginCatalogEntries: mocks.officialCatalog,
}));

const { clearManagedPluginCatalogCache } = await import("./management-catalog.js");
const { installManagedPlugin, setManagedPluginEnabled } = await import("./management-mutations.js");
const { installManagedPluginSource } = await import("./management-install.js");

type InstallOptions = Parameters<typeof installManagedPlugin>[0];
const installPlugin = (
  request: InstallOptions["request"],
  options: Omit<InstallOptions, "request"> = {},
) => installManagedPlugin({ env: {}, ...options, request });
const expectCall = (mock: ReturnType<typeof vi.fn>, fields: Record<string, unknown>) =>
  expect(mock).toHaveBeenCalledWith(expect.objectContaining(fields));
const expectRecord = (fields: Record<string, unknown>, record: Record<string, unknown> = {}) =>
  expectCall(mocks.persistInstall, { ...record, install: expect.objectContaining(fields) });
const mockMetadata = (id: string, fields: Partial<Parameters<typeof metadataSnapshot>[0]> = {}) =>
  mocks.metadata.mockReturnValue(
    metadataSnapshot({ enabled: true, id, origin: "global", ...fields }),
  );

function mockHostedOfficialCatalog(entries: unknown[]) {
  mocks.officialCatalog.mockResolvedValue({
    source: "hosted",
    entries,
    feed: { schemaVersion: 1, id: "test", generatedAt: "now", sequence: 1, entries: [] },
    metadata: { url: "https://clawhub.ai/feed", status: 200, checksum: "hash" },
  });
}

function hostedEntry(id: string, candidates: unknown[], fields: Record<string, unknown> = {}) {
  return {
    id,
    state: "available",
    publisher: { id: "openclaw", trust: "official" },
    install: { candidates },
    ...fields,
  };
}

const emptyArtifactAcknowledgment = {
  reviewToken: computeDeclaredSurfaceHash(
    buildPluginCapabilitySummary({ manifest: {}, origin: "global" }).declared,
  ),
};
const reviewedOfficial = (pluginId: string) => ({
  source: "official" as const,
  pluginId,
  acknowledgeCapabilities: emptyArtifactAcknowledgment,
});
const reviewedClawHub = (packageName: string) => ({
  source: "clawhub" as const,
  packageName,
  acknowledgeCapabilities: emptyArtifactAcknowledgment,
});

function mockClawHubInstall(
  pluginId: string,
  packageName: string,
  clawhubUrl = "https://clawhub.ai",
) {
  const result = {
    ok: true,
    pluginId,
    targetDir: `/tmp/extensions/${pluginId}`,
    extensions: ["index.js"],
    packageName,
    clawhub: {
      source: "clawhub",
      clawhubUrl,
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
      mock.mockReset();
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

  afterEach(() => {
    clearPluginMetadataLifecycleCaches();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  describe("registry refresh", () => {
    beforeEach(() => {
      vi.spyOn(currentMetadata, "getProcessGatewayPluginMetadataSnapshot").mockReturnValue(
        undefined,
      );
    });

    it("reports registry refresh warnings after committed enablement", async () => {
      mocks.readConfig.mockResolvedValue(
        configSnapshot({ plugins: { entries: { workboard: { enabled: false } } } }),
      );
      mocks.replaceConfig.mockResolvedValue({});
      mocks.metadata
        .mockReturnValueOnce(managementMetadata({ enabled: false, curated: false }))
        .mockReturnValueOnce(managementMetadata({ enabled: true, curated: false }));
      mocks.refreshRegistry.mockImplementation(
        async (params: { logger?: { warn?: (message: string) => void } }) => {
          params.logger?.warn?.("Plugin registry refresh failed: registry unavailable");
        },
      );
      const result = await setManagedPluginEnabled({
        pluginId: "workboard",
        enabled: true,
        env: {},
      });
      expect(mocks.replaceConfig).toHaveBeenCalledOnce();
      expect(result).toMatchObject({
        plugin: { enabled: true },
        warnings: ["Plugin registry refresh failed: registry unavailable"],
      });
    });

    it("keeps an ownerless managed install and returns the partial-scope action", async () => {
      const config = {
        agents: {
          ownership: "explicit" as const,
          entries: {
            main: { workspace: "/tmp/main-workspace" },
            gadget: { workspace: "/tmp/gadget-workspace" },
          },
        },
      };
      mockClawHubInstall("workboard", "community/workboard");
      const prepared = configSnapshot(config);
      mocks.readConfig.mockResolvedValue({
        ...prepared,
        snapshot: { ...prepared.snapshot, parsed: config },
      });
      mocks.persistInstall.mockResolvedValue(config);
      mocks.metadata.mockReturnValue(
        managementMetadata({
          enabled: false,
          curated: false,
          installRecord: { source: "clawhub", spec: "clawhub:community/workboard" },
        }),
      );
      const result = await installPlugin(reviewedClawHub("community/workboard"));
      expect(result.plugin.id).toBe("workboard");
      expect(result.warnings).toContainEqual(
        expect.stringContaining("set agents.defaults.systemAgent.agentId"),
      );
    });

    it("requires artifact consent before a linked source is enabled or recorded", async () => {
      const artifactDir = tempDirs.make("managed-linked-consent");
      const stateDir = tempDirs.make("managed-linked-state");
      createColdPluginFixture({
        rootDir: artifactDir,
        pluginId: "linked-plugin",
        manifest: { providers: [], channels: [], channelConfigs: {}, providerAuthChoices: [] },
      });
      const params = {
        request: {
          source: "local" as const,
          path: artifactDir,
          recordSource: "path" as const,
          mode: "install" as const,
          link: true,
        },
        snapshot: {
          config: {},
          baseHash: "base-hash",
          writeOptions: { expectedConfigPath: "/tmp/openclaw.json" },
        },
        env: { OPENCLAW_STATE_DIR: stateDir },
      };
      await expect(installManagedPluginSource(params)).rejects.toMatchObject({
        capabilityConsent: {
          pluginId: "linked-plugin",
          reviewToken: emptyArtifactAcknowledgment.reviewToken,
        },
      });
      expect(mocks.persistInstall).not.toHaveBeenCalled();
      mocks.persistInstall.mockResolvedValue({});
      const result = await installManagedPluginSource({
        ...params,
        acknowledgeCapabilities: emptyArtifactAcknowledgment,
      });
      expect(result.ok).toBe(true);
      expect(mocks.persistInstall.mock.calls[0]?.[0]).toMatchObject({
        install: {
          installPath: artifactDir,
          acceptedSurfaceHash: emptyArtifactAcknowledgment.reviewToken,
        },
        snapshot: { config: { plugins: { load: { paths: [artifactDir] } } } },
      });
    });
  });

  it("refuses managed installs in Nix mode before config or artifact work", async () => {
    mocks.npmInstall.mockResolvedValue({ ok: false, error: "artifact installer reached" });
    mocks.clawhubInstall.mockResolvedValue({ ok: false, error: "artifact installer reached" });
    await expect(
      installPlugin({ source: "official", pluginId: "diffs" }, { env: { OPENCLAW_NIX_MODE: "1" } }),
    ).rejects.toThrow("Config is managed by Nix");
    expect(mocks.readConfig).not.toHaveBeenCalled();
    expect(mocks.clawhubInstall).not.toHaveBeenCalled();
    expect(mocks.npmInstall).not.toHaveBeenCalled();
    expect(mocks.persistInstall).not.toHaveBeenCalled();
  });

  it.each([
    { label: "empty supplied env", env: {} },
    {
      label: "explicit public registry before the legacy alias",
      env: {
        OPENCLAW_CLAWHUB_URL: " https://clawhub.ai/ ",
        CLAWHUB_URL: "https://mirror.example.test",
      },
    },
  ])("pins public ClawHub identity despite ambient custom env ($label)", async ({ env }) => {
    vi.stubEnv("OPENCLAW_CLAWHUB_URL", "https://ambient.example.test");
    vi.stubEnv("CLAWHUB_URL", "https://ambient-legacy.example.test");
    mockHostedOfficialCatalog([hostedFeedDiffsEntry]);
    mockClawHubInstall("impostor", "@openclaw/diffs");
    mockMetadata("impostor");

    await expect(
      installPlugin(
        {
          ...reviewedClawHub("@openclaw/diffs"),
          version: "2026.6.11",
        },
        { env },
      ),
    ).rejects.toThrow("expected diffs, got impostor");
    expect(mocks.officialCatalog).toHaveBeenCalledOnce();
    expectCall(mocks.clawhubInstall, {
      spec: "clawhub:@openclaw/diffs@2026.6.11",
      baseUrl: "https://clawhub.ai",
      expectedPluginId: "diffs",
      expectedIntegrity: `sha256-${Buffer.from("a".repeat(64), "hex").toString("base64")}`,
    });
    expect(mocks.persistInstall).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "primary URL before the legacy alias",
      env: {
        OPENCLAW_CLAWHUB_URL: " https://mirror.example.test/ ",
        CLAWHUB_URL: "https://clawhub.ai",
      },
      channel: "beta",
      constrained: false,
    },
    {
      label: "legacy alias",
      env: { CLAWHUB_URL: "https://mirror.example.test" },
      channel: "extended-stable",
      constrained: false,
    },
    {
      label: "blank primary URL with explicit caller constraints",
      env: { OPENCLAW_CLAWHUB_URL: " ", CLAWHUB_URL: "https://mirror.example.test" },
      channel: "beta",
      constrained: true,
    },
  ] as const)(
    "keeps custom registry authority despite ambient public env ($label)",
    async ({ env, channel, constrained }) => {
      vi.stubEnv("OPENCLAW_CLAWHUB_URL", "https://clawhub.ai");
      vi.stubEnv("CLAWHUB_URL", "https://clawhub.ai");
      mocks.readConfig.mockResolvedValue(configSnapshot({ update: { channel } }));
      mockHostedOfficialCatalog([hostedFeedDiffsEntry]);
      mockClawHubInstall("custom-diffs", "@openclaw/diffs", "https://mirror.example.test");
      mockMetadata("custom-diffs", { name: "Diffs" });
      const constraints = constrained
        ? {
            version: "1.2.3",
            expectedPluginId: "custom-diffs",
            expectedIntegrity: `sha256-${Buffer.from("b".repeat(64), "hex").toString("base64")}`,
          }
        : undefined;
      const spec = constrained ? "clawhub:@openclaw/diffs@1.2.3" : "clawhub:@openclaw/diffs";

      const result = await installPlugin(
        {
          ...reviewedClawHub("@openclaw/diffs"),
          ...constraints,
        },
        { env },
      );

      expect(mocks.officialCatalog).not.toHaveBeenCalled();
      expect(mocks.clawhubInstall).toHaveBeenCalledOnce();
      expectCall(mocks.clawhubInstall, { baseUrl: "https://mirror.example.test", spec });
      const installedRequest = expectDefined(
        mocks.clawhubInstall.mock.calls[0]?.[0],
        "ClawHub installer request",
      );
      expect(installedRequest.expectedPluginId).toBe(constraints?.expectedPluginId);
      expect(installedRequest.expectedIntegrity).toBe(constraints?.expectedIntegrity);
      expect(mocks.persistInstall).toHaveBeenCalledOnce();
      expectRecord(
        { source: "clawhub", spec, clawhubUrl: "https://mirror.example.test" },
        { pluginId: "custom-diffs" },
      );
      expect(result.plugin.id).toBe("custom-diffs");
    },
  );

  it("never falls back after npm security refusal", async () => {
    const failure = { code: "security_scan_blocked", error: "untrusted package" };
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
    const rejected = await installPlugin({ source: "official", pluginId: "diffs" }).catch(
      (error: unknown) => error,
    );
    expect(rejected).toMatchObject({ message: failure.error });
    expect(pluginLifecycleError(rejected, { entered: true })).toMatchObject({
      message: failure.error,
      details: {
        pluginInstallRejected: true,
        pluginInstallCode: failure.code,
        pluginInstallSource: { source: "npm" },
      },
    });
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

      const rejected = await installPlugin({ source: "npm", spec: "@acme/plugin" }).catch(
        (error: unknown) => error,
      );
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

  it.each(["npm", "clawhub"] as const)(
    "retains canonical official recovery with a hosted %s primary and no bundled copy",
    async (source) => {
      vi.spyOn(bundledSources, "findBundledPluginSource").mockReturnValue(undefined);
      const packageName = "@openclaw/brave-plugin";
      const config = { tools: { web: { search: { provider: "brave" } } } };
      const prepared = configSnapshot(config);
      mocks.readConfig.mockResolvedValue({
        ...prepared,
        snapshot: {
          ...prepared.snapshot,
          valid: false,
          exists: true,
          parsed: config,
          config,
          issues: [
            {
              path: "tools.web.search.provider",
              message:
                'web_search provider is not available: brave (install or enable plugin "brave")',
            },
          ],
          legacyIssues: [],
        },
      });
      // The hosted feed supplies artifacts; Brave's local descriptor owns recovery permission.
      mockHostedOfficialCatalog([
        hostedEntry(packageName, [{ sourceRef: `public-${source}`, package: packageName }]),
      ]);
      if (source === "clawhub") {
        mockClawHubInstall("brave", packageName);
      } else {
        mocks.npmInstall.mockResolvedValue({
          ok: true,
          pluginId: "brave",
          targetDir: "/tmp/extensions/brave",
          extensions: ["index.js"],
          packageName,
        });
      }
      mocks.persistInstall.mockResolvedValue(config);
      mockMetadata("brave");

      const result = await installPlugin(reviewedOfficial("brave"));

      expectCall(source === "npm" ? mocks.npmInstall : mocks.clawhubInstall, {
        expectedPluginId: "brave",
      });
      expect(source === "npm" ? mocks.clawhubInstall : mocks.npmInstall).not.toHaveBeenCalled();
      expectRecord(
        { source },
        {
          pluginId: "brave",
          snapshot: expect.objectContaining({ config }),
        },
      );
      expect(result.plugin.id).toBe("brave");
    },
  );

  it.each(["https://clawhub.ai", "https://mirror.example.test"])(
    "keeps each hosted source's exact version and integrity on fallback through %s",
    async (clawhubUrl) => {
      vi.stubEnv("OPENCLAW_COMPATIBILITY_HOST_VERSION", "2026.9.7");
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
      mockClawHubInstall("diffs", "@openclaw/diffs", clawhubUrl);
      mocks.clawhubInstall.mockResolvedValueOnce({
        ok: false,
        code: "version_not_found",
        error: "unpublished cohort",
      });
      mockMetadata("diffs");
      await installPlugin(reviewedOfficial("diffs"), { env: { OPENCLAW_CLAWHUB_URL: clawhubUrl } });
      expectCall(mocks.npmInstall, {
        spec: "@openclaw/diffs@2026.6.11",
        expectedIntegrity: "sha512-test",
      });
      const attempts = mocks.clawhubInstall.mock.calls.map(([request]) => ({
        baseUrl: request.baseUrl,
        spec: request.spec,
        expectedPluginId: request.expectedPluginId,
        expectedIntegrity: request.expectedIntegrity,
      }));
      expect(attempts).toEqual([
        {
          baseUrl: clawhubUrl,
          spec: "clawhub:@openclaw/diffs@2026.9.7",
          expectedPluginId: "diffs",
          expectedIntegrity: undefined,
        },
        {
          baseUrl: clawhubUrl,
          spec: "clawhub:@openclaw/diffs@2026.6.11",
          expectedPluginId: "diffs",
          expectedIntegrity: `sha256-${Buffer.from("a".repeat(64), "hex").toString("base64")}`,
        },
      ]);
      expectRecord({ spec: "clawhub:@openclaw/diffs", clawhubUrl });
    },
  );

  it.each(["available", "missing", "incompatible-fallback", "catalog-cohort", "dev"] as const)(
    "resolves official install defaults: %s",
    async (release) => {
      vi.stubEnv(
        "OPENCLAW_COMPATIBILITY_HOST_VERSION",
        release === "catalog-cohort" ? "2026.9.9" : "2026.9.7",
      );
      if (release === "dev") {
        mocks.readConfig.mockResolvedValue(configSnapshot({ update: { channel: "dev" } }));
      }
      const packageName = "@openclaw/perplexity-plugin";
      const catalogSpec = `clawhub:${packageName}@2026.9.9`;
      const integrity = `sha256-${Buffer.from("a".repeat(64), "hex").toString("base64")}`;
      mockHostedOfficialCatalog([
        hostedEntry(
          packageName,
          [{ sourceRef: "public-clawhub", package: packageName, version: "2026.9.9", integrity }],
          { openclaw: { plugin: { id: "perplexity" } } },
        ),
      ]);
      const installed = mockClawHubInstall("perplexity", packageName);
      const refusal = {
        ok: false,
        code: "incompatible_plugin_api",
        error: "requires plugin API >=2026.9.9; choose an explicit compatible plugin version",
      };
      mocks.clawhubInstall.mockImplementation(({ spec }: { spec: string }) =>
        spec.endsWith("@2026.9.7") && release !== "available"
          ? { ok: false, code: "version_not_found", error: "unpublished" }
          : spec === catalogSpec && (release === "available" || release === "incompatible-fallback")
            ? refusal
            : installed,
      );
      mockMetadata("perplexity");
      const warn = vi.fn();
      const install = installPlugin(reviewedOfficial("perplexity"), { logger: { warn } });
      if (release === "incompatible-fallback") {
        await expect(install).rejects.toThrow(refusal.error);
        expect(mocks.persistInstall).not.toHaveBeenCalled();
      } else {
        await install;
        expectRecord({ spec: `clawhub:${packageName}` });
      }
      const attempts = mocks.clawhubInstall.mock.calls.map(([request]) => ({
        spec: request.spec,
        expectedIntegrity: request.expectedIntegrity,
      }));
      const cohort = { spec: `clawhub:${packageName}@2026.9.7`, expectedIntegrity: undefined };
      const catalog = { spec: catalogSpec, expectedIntegrity: integrity };
      expect(attempts).toEqual(
        release === "available"
          ? [cohort]
          : release === "catalog-cohort" || release === "dev"
            ? [catalog]
            : [cohort, catalog],
      );
      if (release === "missing" || release === "incompatible-fallback") {
        expect(warn).toHaveBeenCalledWith(
          expect.stringContaining(
            `No ${cohort.spec} release is published; installing ${catalogSpec} instead.`,
          ),
        );
      } else {
        expect(warn).not.toHaveBeenCalled();
      }
    },
  );

  it.each([
    { version: "2026.9.7" },
    { version: "beta" },
    { version: "latest", expectedIntegrity: `sha256-${"b".repeat(64)}` },
  ])("preserves an explicit ClawHub selector or digest: %j", async (selector) => {
    mockClawHubInstall("perplexity", "@openclaw/perplexity-plugin");
    mockMetadata("perplexity");
    await installPlugin({
      ...reviewedClawHub("@openclaw/perplexity-plugin"),
      ...selector,
    });
    expectCall(mocks.clawhubInstall, {
      spec: `clawhub:@openclaw/perplexity-plugin@${selector.version}`,
    });
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
      hostedEntry(
        "@openclaw/bluebubbles",
        [{ sourceRef: "public-clawhub", package: "@openclaw/bluebubbles" }],
        { title: "BlueBubbles" },
      ),
    ]);
    mockClawHubInstall("bluebubbles", "@openclaw/bluebubbles");
    mocks.refreshRegistry.mockResolvedValue(undefined);
    mockMetadata("bluebubbles", {
      enabled: false,
      name: "BlueBubbles",
      installRecord,
    });

    const result = await installPlugin(reviewedClawHub("@openclaw/bluebubbles"));

    expect(mocks.clawhubInstall).toHaveBeenCalledWith(
      expect.not.objectContaining({ expectedPluginId: expect.anything() }),
    );
    expectCall(mocks.clawhubInstall, { spec: "clawhub:@openclaw/bluebubbles@beta" });
    expectRecord({ spec: "clawhub:@openclaw/bluebubbles" });
    expect(result.plugin.id).toBe("bluebubbles");
  });

  it("keeps the runtime-id pin when a declared id equals the package name", async () => {
    // An unscoped package can legitimately declare its package name as the runtime id.
    mockHostedOfficialCatalog([
      hostedEntry("sonos", [{ sourceRef: "public-clawhub", package: "sonos" }], {
        title: "Sonos",
        openclaw: { plugin: { id: "sonos" } },
      }),
    ]);
    mockClawHubInstall("impostor", "sonos");

    await expect(installPlugin({ source: "clawhub", packageName: "sonos" })).rejects.toThrow(
      "expected sonos, got impostor",
    );
    expectCall(mocks.clawhubInstall, { expectedPluginId: "sonos" });
  });

  it("approves every install-policy warning in an acknowledged Gateway install", async () => {
    mockHostedOfficialCatalog([hostedFeedDiffsEntry]);
    const installed = mockClawHubInstall("diffs", "@openclaw/diffs");
    mocks.clawhubInstall.mockImplementation(
      async (params: Parameters<typeof import("./clawhub.js").installPluginFromClawHub>[0]) => {
        const callback = expectDefined(
          params.onInstallPolicyWarning,
          "install policy acknowledgement callback",
        );
        for (const reason of ["Review package metadata", "Review installed dependencies"]) {
          await expect(
            callback({ targetName: "diffs", targetType: "plugin", requestMode: "install", reason }),
          ).resolves.toEqual({ status: "approved" });
        }
        return installed;
      },
    );

    mockMetadata("diffs", { name: "Diffs" });

    await installPlugin({
      ...reviewedOfficial("diffs"),
      acknowledgeInstallPolicyWarning: true,
    });
  });

  it("serializes install and enable mutations through one Gateway lock", async () => {
    const heldPersist = createDeferredCore<Record<string, unknown>>();
    const persistEntered = createDeferredCore();
    mockClawHubInstall("demo", "community/demo");
    mocks.persistInstall.mockImplementationOnce(() => {
      persistEntered.resolve();
      return heldPersist.promise;
    });
    mocks.replaceConfig.mockResolvedValue({});
    mocks.refreshRegistry.mockResolvedValue(undefined);
    mocks.metadata
      .mockReturnValueOnce(metadataSnapshot({ enabled: true, id: "demo", origin: "global" }))
      .mockReturnValueOnce(metadataSnapshot({ enabled: false }))
      .mockReturnValueOnce(metadataSnapshot({ enabled: true }));

    const install = installPlugin(reviewedClawHub("community/demo"));
    let enable: ReturnType<typeof setManagedPluginEnabled> | undefined;
    try {
      await Promise.race([persistEntered.promise, install]);
      expect(mocks.persistInstall).toHaveBeenCalledTimes(1);
      enable = setManagedPluginEnabled({ pluginId: "workboard", enabled: true, env: {} });
      await Promise.resolve();

      expect(mocks.readConfig).toHaveBeenCalledTimes(1);
      heldPersist.resolve({});
      await install;
      await enable;
      expect(mocks.readConfig).toHaveBeenCalledTimes(2);
    } finally {
      heldPersist.resolve({});
      await Promise.allSettled(enable ? [install, enable] : [install]);
    }
  });
});

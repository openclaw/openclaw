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
  mockHostedOfficialCatalog,
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
  readConfigFileSnapshotForWrite: mocks.readConfig,
  replaceConfigFile: mocks.replaceConfig,
}));

vi.mock("./install-persistence.js", () => ({
  persistPluginInstall: mocks.persistInstall,
}));

vi.mock("./install-config-mutation.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./install-config-mutation.js")>()),
  resolveInstallConfigMutationPreflights: mocks.preflight,
  selectInstallMutationWriteOptions: (writeOptions: unknown) => writeOptions,
}));

vi.mock("./slot-selection.js", () => ({
  applySlotSelectionForPlugin: (config: unknown) => config,
}));

vi.mock("./registry-refresh.js", () => ({
  refreshPluginRegistryAfterConfigMutation: mocks.refreshRegistry,
}));

vi.mock("./plugin-metadata-snapshot.js", () => ({
  loadPluginMetadataSnapshot: mocks.metadata,
  resolvePluginMetadataSnapshot: mocks.metadata,
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
function mockConfig(config: Record<string, unknown> = {}, snapshot: Record<string, unknown> = {}) {
  const prepared = configSnapshot(config);
  mocks.readConfig.mockResolvedValue({
    ...prepared,
    snapshot: { ...prepared.snapshot, ...snapshot },
  });
}

function mockHostedPackage(
  packageName: string,
  candidate: Partial<(typeof hostedFeedDiffsEntry.install.candidates)[number]> = {},
  pluginId?: string,
) {
  mockHostedOfficialCatalog(mocks.officialCatalog, [
    {
      id: packageName,
      state: "available",
      publisher: { id: "openclaw", trust: "official" },
      install: {
        candidates: [{ sourceRef: "public-clawhub", package: packageName, ...candidate }],
      },
      ...(pluginId ? { openclaw: { plugin: { id: pluginId } } } : {}),
    },
  ]);
}

const publicUrl = "https://clawhub.ai";
const mirrorUrl = "https://mirror.example.test";
const diffsPackage = "@openclaw/diffs";
const catalogIntegrity = `sha256-${Buffer.from("a".repeat(64), "hex").toString("base64")}`;
const emptyManifest = { providers: [], channels: [], channelConfigs: {}, providerAuthChoices: [] };
const expectNoInstall = () => {
  for (const mock of [mocks.npmInstall, mocks.clawhubInstall, mocks.persistInstall]) {
    expect(mock).not.toHaveBeenCalled();
  }
};

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

function artifact(pluginId: string, packageName: string) {
  return {
    ok: true,
    pluginId,
    targetDir: `/tmp/extensions/${pluginId}`,
    extensions: ["index.js"],
    packageName,
  };
}
function mockClawHubInstall(pluginId: string, packageName: string, clawhubUrl = publicUrl) {
  const result = {
    ...artifact(pluginId, packageName),
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

function mockInstalledPlugin(id: string, packageName: string, clawhubUrl = publicUrl) {
  mockMetadata(id);
  return mockClawHubInstall(id, packageName, clawhubUrl);
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
    mocks.preflight.mockReturnValue({
      hookMutation: { mode: "allowed" },
      pluginMutation: { mode: "allowed" },
    });
    mocks.installRecords.mockResolvedValue({});
    mockConfig();
    mocks.persistInstall.mockResolvedValue({});
    mockHostedOfficialCatalog(mocks.officialCatalog, []);
  });

  afterEach(() => {
    clearPluginMetadataLifecycleCaches();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("reports registry refresh warnings after committed enablement", async () => {
    vi.spyOn(currentMetadata, "getProcessGatewayPluginMetadataSnapshot").mockReturnValue(undefined);
    const warning = "Plugin registry refresh failed: registry unavailable";
    mockConfig({ plugins: { entries: { workboard: { enabled: false } } } });
    mocks.replaceConfig.mockResolvedValue({});
    mocks.metadata
      .mockReturnValueOnce(managementMetadata({ enabled: false, curated: false }))
      .mockReturnValueOnce(managementMetadata({ enabled: true, curated: false }));
    mocks.refreshRegistry.mockImplementation(
      async (params: { logger?: { warn?: (message: string) => void } }) => {
        params.logger?.warn?.(warning);
      },
    );
    const result = await setManagedPluginEnabled({ pluginId: "workboard", enabled: true, env: {} });
    expect(result).toMatchObject({
      plugin: { enabled: true },
      warnings: [warning],
    });
  });

  it("keeps an ownerless managed install and returns the partial-scope action", async () => {
    vi.spyOn(currentMetadata, "getProcessGatewayPluginMetadataSnapshot").mockReturnValue(undefined);
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
    mockConfig(config, { parsed: config });
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
    createColdPluginFixture({
      rootDir: artifactDir,
      pluginId: "linked-plugin",
      manifest: emptyManifest,
    });
    const params: Parameters<typeof installManagedPluginSource>[0] = {
      request: {
        source: "local",
        path: artifactDir,
        recordSource: "path",
        mode: "install",
        link: true,
      },
      snapshot: { config: {}, baseHash: undefined, writeOptions: {} },
      env: { OPENCLAW_STATE_DIR: tempDirs.make("managed-linked-state") },
    };
    await expect(installManagedPluginSource(params)).rejects.toMatchObject({
      capabilityConsent: {
        pluginId: "linked-plugin",
        reviewToken: emptyArtifactAcknowledgment.reviewToken,
      },
    });
    expect(mocks.persistInstall).not.toHaveBeenCalled();
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
  it("refuses managed installs in Nix mode before config or artifact work", async () => {
    await expect(
      installPlugin({ source: "official", pluginId: "diffs" }, { env: { OPENCLAW_NIX_MODE: "1" } }),
    ).rejects.toThrow("Config is managed by Nix");
    expect(mocks.readConfig).not.toHaveBeenCalled();
    expectNoInstall();
  });

  it.each([
    [diffsPackage, "diffs", "impostor", {}, "2026.6.11"],
    [
      diffsPackage,
      "diffs",
      "impostor",
      { OPENCLAW_CLAWHUB_URL: ` ${publicUrl}/ `, CLAWHUB_URL: mirrorUrl },
      "2026.6.11",
    ],
    ["@openclaw/bluebubbles", undefined, "bluebubbles", {}, undefined],
    ["sonos", "sonos", "impostor", {}, undefined],
  ] as const)(
    "uses only declared public identity: %s / %j",
    async (name, declared, actual, env, version) => {
      vi.stubEnv("OPENCLAW_CLAWHUB_URL", "https://ambient.example.test");
      vi.stubEnv("CLAWHUB_URL", "https://ambient-legacy.example.test");
      mockConfig({ update: { channel: "beta" } });
      if (name === diffsPackage) {
        mockHostedOfficialCatalog(mocks.officialCatalog, [hostedFeedDiffsEntry]);
      } else {
        mockHostedPackage(name, {}, declared);
      }
      mockInstalledPlugin(actual, name);
      const install = installPlugin({ ...reviewedClawHub(name), version }, { env });
      if (declared) {
        await expect(install).rejects.toThrow(`expected ${declared}, got ${actual}`);
        expect(mocks.persistInstall).not.toHaveBeenCalled();
      } else {
        expect((await install).plugin.id).toBe(actual);
        expectRecord({ spec: `clawhub:${name}` });
      }
      expectCall(mocks.clawhubInstall, {
        baseUrl: publicUrl,
        spec: `clawhub:${name}@${version ?? "beta"}`,
      });
      expect(mocks.clawhubInstall.mock.calls[0]?.[0].expectedPluginId).toBe(declared);
      if (name === diffsPackage) {
        expectCall(mocks.clawhubInstall, { expectedIntegrity: catalogIntegrity });
      }
    },
  );

  it.each([
    ["primary URL before alias", ` ${mirrorUrl}/ `, publicUrl, "beta", false],
    ["legacy alias", undefined, mirrorUrl, "extended-stable", false],
    ["blank primary with constraints", " ", mirrorUrl, "beta", true],
  ] as const)(
    "keeps custom registry authority despite ambient public env (%s)",
    async (_label, primary, legacy, channel, constrained) => {
      const env = { OPENCLAW_CLAWHUB_URL: primary, CLAWHUB_URL: legacy };
      vi.stubEnv("OPENCLAW_CLAWHUB_URL", publicUrl);
      vi.stubEnv("CLAWHUB_URL", publicUrl);
      mockConfig({ update: { channel } });
      mockHostedOfficialCatalog(mocks.officialCatalog, [hostedFeedDiffsEntry]);
      mockInstalledPlugin("custom-diffs", diffsPackage, mirrorUrl);
      const constraints = constrained
        ? {
            version: "1.2.3",
            expectedPluginId: "custom-diffs",
            expectedIntegrity: `sha256-${Buffer.from("b".repeat(64), "hex").toString("base64")}`,
          }
        : undefined;
      const spec = `clawhub:${diffsPackage}${constrained ? "@1.2.3" : ""}`;

      const result = await installPlugin(
        { ...reviewedClawHub(diffsPackage), ...constraints },
        { env },
      );

      expect(mocks.officialCatalog).not.toHaveBeenCalled();
      expectCall(mocks.clawhubInstall, { baseUrl: mirrorUrl, spec });
      const request = mocks.clawhubInstall.mock.calls[0]?.[0];
      expect([request.expectedPluginId, request.expectedIntegrity]).toEqual([
        constraints?.expectedPluginId,
        constraints?.expectedIntegrity,
      ]);
      expectRecord(
        { source: "clawhub", spec, clawhubUrl: mirrorUrl },
        { pluginId: "custom-diffs" },
      );
      expect(result.plugin.id).toBe("custom-diffs");
    },
  );

  it("never falls back after npm security refusal", async () => {
    const failure = { code: "security_scan_blocked", error: "untrusted package" };
    mockHostedOfficialCatalog(mocks.officialCatalog, [
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
  ])("projects config refusal without the snapshot: valid=$valid", async ({ valid, reason }) => {
    mockConfig({}, { valid });
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
    expectNoInstall();
  });

  it.each(["npm", "clawhub"] as const)(
    "recovers official config through hosted %s without a bundled copy",
    async (source) => {
      vi.spyOn(bundledSources, "findBundledPluginSource").mockReturnValue(undefined);
      const packageName = "@openclaw/brave-plugin";
      const config = { tools: { web: { search: { provider: "brave" } } } };
      mockConfig(config, {
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
      });
      // The hosted feed supplies artifacts; Brave's local descriptor owns recovery permission.
      mockHostedPackage(packageName, { sourceRef: `public-${source}` });
      if (source === "clawhub") {
        mockClawHubInstall("brave", packageName);
      } else {
        mocks.npmInstall.mockResolvedValue(artifact("brave", packageName));
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
        { pluginId: "brave", snapshot: expect.objectContaining({ config }) },
      );
      expect(result.plugin.id).toBe("brave");
    },
  );

  it.each([
    ["public fallback", publicUrl, "2026.9.7", "stable", ["2026.9.7", "2026.6.11"], false],
    ["custom fallback", mirrorUrl, "2026.9.7", "stable", ["2026.9.7", "2026.6.11"], false],
    ["available", publicUrl, "2026.9.7", "stable", ["2026.9.7"], false],
    ["incompatible fallback", publicUrl, "2026.9.7", "stable", ["2026.9.7", "2026.6.11"], true],
    ["catalog cohort", publicUrl, "2026.6.11", "stable", ["2026.6.11"], false],
    ["dev", publicUrl, "2026.9.7", "dev", ["2026.6.11"], false],
  ] as const)(
    "preserves release selection, source identity and integrity: %s",
    async (_label, clawhubUrl, host, channel, versions, refused) => {
      vi.stubEnv("OPENCLAW_COMPATIBILITY_HOST_VERSION", host);
      mockConfig({ update: { channel } });
      mockHostedOfficialCatalog(mocks.officialCatalog, [
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
      mockInstalledPlugin("diffs", diffsPackage, clawhubUrl);
      if (versions.length === 2) {
        mocks.clawhubInstall.mockResolvedValueOnce({
          ok: false,
          code: "version_not_found",
          error: "unpublished",
        });
      }
      if (refused) {
        mocks.clawhubInstall.mockResolvedValueOnce({
          ok: false,
          code: "incompatible_plugin_api",
          error: "incompatible plugin API",
        });
      }
      const warn = vi.fn();
      const install = installPlugin(reviewedOfficial("diffs"), {
        env: { OPENCLAW_CLAWHUB_URL: clawhubUrl },
        logger: { warn },
      });
      if (refused) {
        await expect(install).rejects.toThrow("incompatible plugin API");
        expect(mocks.persistInstall).not.toHaveBeenCalled();
      } else {
        await install;
        expectRecord({ spec: `clawhub:${diffsPackage}`, clawhubUrl });
      }
      expectCall(mocks.npmInstall, {
        spec: `${diffsPackage}@2026.6.11`,
        expectedIntegrity: "sha512-test",
      });
      expect(
        mocks.clawhubInstall.mock.calls.map(([r]) => [
          r.baseUrl,
          r.spec,
          r.expectedPluginId,
          r.expectedIntegrity,
        ]),
      ).toEqual(
        versions.map((version) => [
          clawhubUrl,
          `clawhub:${diffsPackage}@${version}`,
          "diffs",
          version === "2026.6.11" ? catalogIntegrity : undefined,
        ]),
      );
      if (versions.length === 2) {
        expect(warn).toHaveBeenCalledWith(
          expect.stringContaining(
            `No clawhub:${diffsPackage}@${host} release is published; installing clawhub:${diffsPackage}@2026.6.11 instead.`,
          ),
        );
      } else {
        expect(
          warn.mock.calls.flat().some((message) => String(message).startsWith("No clawhub:")),
        ).toBe(false);
      }
    },
  );

  it("preserves an explicit digest instead of selecting the host cohort", async () => {
    const name = "@openclaw/perplexity-plugin";
    const expectedIntegrity = `sha256-${"b".repeat(64)}`;
    mockInstalledPlugin("perplexity", name);
    await installPlugin({ ...reviewedClawHub(name), version: "latest", expectedIntegrity });
    expectCall(mocks.clawhubInstall, { spec: `clawhub:${name}@latest`, expectedIntegrity });
  });

  it("approves every install-policy warning in an acknowledged Gateway install", async () => {
    mockHostedOfficialCatalog(mocks.officialCatalog, [hostedFeedDiffsEntry]);
    const installed = mockClawHubInstall("diffs", diffsPackage);
    mockMetadata("diffs", { name: "Diffs" });
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

import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConfigReplaceInput } from "../config/mutate.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { resolvePluginArtifactDeclaredSurface } from "./capability-artifact.js";
import {
  createManagedPluginArtifactConsentHandler,
  resolvePluginCapabilityConsent,
  type PluginCapabilityConsentHandler,
} from "./capability-consent.js";
import { buildPluginCapabilitySummary, computeDeclaredSurfaceHash } from "./capability-summary.js";
import { recordInstalledPluginIndexInstallOwner } from "./installed-plugin-index-install-owner.js";
import { loadInstalledPluginIndexWithDiscovery } from "./installed-plugin-index.js";
import {
  configSnapshot,
  emptyMetadataSnapshot,
  metadataSnapshot,
} from "./management-service.test-helpers.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";
import { createColdPluginFixture } from "./test-helpers/cold-plugin-fixtures.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "./test-helpers/fs-fixtures.js";

const mocks = vi.hoisted(() => ({
  metadata: vi.fn(),
  officialCatalog: vi.fn(),
  readConfig: vi.fn(),
  records: {} as Record<string, import("../config/types.plugins.js").PluginInstallRecord>,
  replaceConfig: vi.fn(),
  writeRecords: vi.fn(),
  slotSelection: vi.fn((config) => config),
}));

vi.mock("../config/config.js", () => ({
  assertConfigWriteAllowedInCurrentMode: () => undefined,
  readConfigFileSnapshotForWrite: () => mocks.readConfig(),
  replaceConfigFile: (params: unknown) => mocks.replaceConfig(params),
}));

vi.mock("./install-config-mutation.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./install-config-mutation.js")>()),
  resolveInstallConfigMutationPreflights: () => ({
    hookMutation: { mode: "allowed" },
    pluginMutation: { mode: "allowed" },
  }),
  selectInstallMutationWriteOptions: (writeOptions: unknown) => writeOptions,
}));

vi.mock("./installed-plugin-index-records.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./installed-plugin-index-records.js")>()),
  loadInstalledPluginIndexInstallRecords: async () => ({ ...mocks.records }),
  writePersistedInstalledPluginIndexInstallRecordsWithLease: async (
    records: Record<string, import("../config/types.plugins.js").PluginInstallRecord>,
    options: unknown,
  ) => {
    mocks.records = { ...records };
    mocks.writeRecords(records, options);
  },
}));

vi.mock("./plugin-lifecycle-lease.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./plugin-lifecycle-lease.js")>()),
  withPluginLifecycleLeaseAsync: async (
    _options: unknown,
    run: (lease: {
      assertOwned: () => void;
      assertCurrent: () => void;
      assertOwnedInTransaction: () => void;
      signal: AbortSignal;
      databasePath: string;
    }) => Promise<unknown>,
  ) =>
    run({
      assertOwned: () => undefined,
      assertCurrent: () => undefined,
      assertOwnedInTransaction: () => undefined,
      signal: new AbortController().signal,
      databasePath: "/tmp/managed-capability-consent.sqlite",
    }),
}));

vi.mock("./slot-selection.js", () => ({ applySlotSelectionForPlugin: mocks.slotSelection }));
vi.mock("./registry-refresh.js", () => ({ refreshPluginRegistryAfterConfigMutation: vi.fn() }));

vi.mock("./plugin-metadata-snapshot.js", () => ({
  loadPluginMetadataSnapshot: (...args: unknown[]) => mocks.metadata(...args),
  resolvePluginMetadataSnapshot: (...args: unknown[]) => mocks.metadata(...args),
}));

vi.mock("./official-external-plugin-catalog.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./official-external-plugin-catalog.js")>()),
  loadConfiguredHostedOfficialExternalPluginCatalogEntries: (...args: unknown[]) =>
    mocks.officialCatalog(...args),
}));

const { clearManagedPluginCatalogCache } = await import("./management-catalog.js");
const { inspectManagedPlugin, listManagedPlugins } = await import("./management-service.js");
const { setManagedPluginEnabled } = await import("./management-mutations.js");

const trackedArtifactDirs: string[] = [];

const consent = (params: Partial<Parameters<typeof resolvePluginCapabilityConsent>[0]> = {}) =>
  resolvePluginCapabilityConsent({ config: {}, env: {}, pluginId: "community-plugin", ...params });
const inspect = (params: Partial<Parameters<typeof inspectManagedPlugin>[0]> = {}) =>
  inspectManagedPlugin({ config: {}, env: {}, pluginId: "community-plugin", ...params });
const artifactHandler = (
  params: Partial<Parameters<typeof createManagedPluginArtifactConsentHandler>[0]> = {},
) => createManagedPluginArtifactConsentHandler({ config: {}, source: "npm", ...params });
const stagedArtifact = (stagedArtifactDir: string, pluginId = "diffs") => ({
  pluginId,
  stagedArtifactDir,
  mode: "install" as const,
});

function discoverMetadata(
  params: NonNullable<Parameters<typeof loadInstalledPluginIndexWithDiscovery>[0]>,
  liveRecords = false,
) {
  const { index, manifestRegistry } = loadInstalledPluginIndexWithDiscovery(params);
  const byPluginId = new Map(manifestRegistry.plugins.map((manifest) => [manifest.id, manifest]));
  mocks.records = params.installRecords ?? {};
  const metadata = {
    index,
    byPluginId,
    plugins: manifestRegistry.plugins,
    diagnostics: manifestRegistry.diagnostics,
    normalizePluginId: (pluginId: string) => pluginId,
  };
  mocks.metadata.mockImplementation(() =>
    liveRecords
      ? { ...metadata, index: { ...index, installRecords: { ...mocks.records } } }
      : metadata,
  );
  return byPluginId;
}

const discoveryEnv = (rootDir: string) => ({
  HOME: rootDir,
  OPENCLAW_STATE_DIR: path.join(rootDir, "state"),
  OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
  OPENCLAW_DISABLE_BUNDLED_SOURCE_OVERLAYS: "1",
});

function createConsentArtifact(pluginId = "community-plugin", providers: string[] = []): string {
  const rootDir = makeTrackedTempDir("managed-capability-consent", trackedArtifactDirs);
  writeConsentArtifact(rootDir, pluginId, providers);
  return rootDir;
}

function writeConsentArtifact(rootDir: string, pluginId: string, providers: string[] = []): void {
  createColdPluginFixture({
    rootDir,
    pluginId,
    manifest: {
      name: "Community Plugin",
      providers,
      channels: [],
      channelConfigs: {},
      providerAuthChoices: [],
    },
  });
}

function installRecord(overrides: Partial<PluginInstallRecord> = {}): PluginInstallRecord {
  return {
    source: "npm",
    installPath: overrides.installPath ?? createConsentArtifact(),
    integrity: "sha512-verified-artifact",
    ...overrides,
  };
}

function artifactReviewToken(record: PluginInstallRecord): string {
  if (!record.installPath) {
    throw new Error("test plugin must have a tracked artifact path");
  }
  return computeDeclaredSurfaceHash(resolvePluginArtifactDeclaredSurface(record.installPath));
}

function configureExternalPlugin(
  record: PluginInstallRecord,
  enabled = false,
): ReturnType<typeof metadataSnapshot> {
  mocks.records = { "community-plugin": record };
  const snapshot = metadataSnapshot({
    id: "community-plugin",
    name: "Community Plugin",
    enabled,
    origin: "global",
    installRecord: record,
  });
  if (record.installPath) {
    snapshot.index.plugins[0]!.rootDir = record.installPath;
    snapshot.byPluginId.get("community-plugin")!.rootDir = record.installPath;
  }
  mocks.metadata.mockImplementation(() => ({
    ...snapshot,
    index: { ...snapshot.index, installRecords: { ...mocks.records } },
  }));
  return snapshot;
}

describe("managed plugin capability consent", () => {
  afterEach(() => cleanupTrackedTempDirs(trackedArtifactDirs));

  beforeEach(() => {
    vi.clearAllMocks();
    clearManagedPluginCatalogCache();
    clearPluginMetadataLifecycleCaches();
    mocks.records = {};
    mocks.officialCatalog.mockResolvedValue({ source: "hosted", entries: [] });
    mocks.readConfig.mockResolvedValue(configSnapshot());
    mocks.replaceConfig.mockImplementation(async (params: ConfigReplaceInput) => {
      const config = params.sourceConfig ?? params.nextConfig;
      return {
        path: "/tmp/openclaw.json",
        nextConfig: config,
        persistedHash: "committed",
        persistedSourceConfig: config,
      };
    });
  });

  it.each([
    { name: "global disable", plugins: { enabled: false }, reason: "plugins disabled" },
    { name: "denylist", plugins: { deny: ["community-plugin"] }, reason: "blocked by denylist" },
    {
      name: "restrictive allowlist",
      plugins: { allow: ["other-plugin"] },
      reason: "blocked by allowlist",
    },
  ])(
    "preserves CLI $name before consent, persistence, or slot selection",
    async ({ plugins, reason }) => {
      const record = installRecord();
      configureExternalPlugin(record);
      mocks.readConfig.mockResolvedValue(configSnapshot({ plugins }));
      const applyRuntime = vi.fn();
      const request = {
        pluginId: "community-plugin",
        enabled: true,
        allowlistPolicy: "preserve" as const,
        acknowledgeCapabilities: { reviewToken: artifactReviewToken(record) },
        applyRuntime,
        env: {},
      };
      await expect(setManagedPluginEnabled(request)).rejects.toThrow(reason);
      expect(mocks.writeRecords).not.toHaveBeenCalled();
      expect(mocks.replaceConfig).not.toHaveBeenCalled();
      expect(mocks.slotSelection).not.toHaveBeenCalled();
      expect(applyRuntime).not.toHaveBeenCalled();
    },
  );

  it.each([
    { name: "admin omission", pluginId: "community-plugin", allowlistPolicy: undefined },
    {
      name: "explicit-selection exception",
      pluginId: "clickclack",
      allowlistPolicy: "preserve" as const,
    },
  ])("retains $name enablement", async ({ pluginId, allowlistPolicy }) => {
    mocks.metadata.mockReturnValue(metadataSnapshot({ enabled: false, id: pluginId }));
    mocks.readConfig.mockResolvedValue(configSnapshot({ plugins: { allow: ["other-plugin"] } }));
    const applyRuntime = vi.fn(async () => ({
      operationId: "enable",
      generation: 2,
      pluginIds: [pluginId],
    }));
    const request = {
      pluginId,
      enabled: true,
      ...(allowlistPolicy ? { allowlistPolicy } : {}),
      applyRuntime,
      env: {},
    };
    await setManagedPluginEnabled(request);
    expect(mocks.replaceConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceConfig: expect.objectContaining({
          plugins: expect.objectContaining({ allow: ["other-plugin", pluginId] }),
        }),
      }),
    );
    expect(mocks.slotSelection).toHaveBeenCalledOnce();
    expect(applyRuntime).toHaveBeenCalledOnce();
  });

  function officialArtifact() {
    const rootDir = makeTrackedTempDir("official-capability-consent", trackedArtifactDirs);
    createColdPluginFixture({
      rootDir,
      pluginId: "diffs",
      packageName: "@openclaw/diffs",
      manifest: { providers: [], channels: [], channelConfigs: {}, providerAuthChoices: [] },
    });
    return rootDir;
  }

  const officialRecord: PluginInstallRecord = {
    source: "npm",
    spec: "@openclaw/diffs@1.0.0",
    resolvedName: "@openclaw/diffs",
    resolvedSpec: "@openclaw/diffs@1.0.0",
    integrity: "sha512-official-artifact",
  };

  it("rechecks first-party package identity after the commit guard yields", async () => {
    const rootDir = officialArtifact();
    const handler = artifactHandler({
      beforePersistentEffect: async () => {
        const packagePath = path.join(rootDir, "package.json");
        const manifest = JSON.parse(fs.readFileSync(packagePath, "utf8"));
        fs.writeFileSync(packagePath, JSON.stringify({ ...manifest, name: "@vendor/diffs" }));
      },
    });
    await expect(
      handler.onBeforePluginArtifactCommit({
        ...stagedArtifact(rootDir),
        sourceRecord: officialRecord,
      }),
    ).rejects.toMatchObject({ capabilityConsent: { pluginId: "diffs" } });
  });

  it("does not carry a first-party exemption into an unverified fallback stage", async () => {
    const rootDir = officialArtifact();
    const handler = artifactHandler();
    const artifact = stagedArtifact(rootDir);
    await handler.onBeforePluginArtifactCommit({ ...artifact, sourceRecord: officialRecord });
    await expect(handler.onBeforePluginArtifactCommit(artifact)).rejects.toMatchObject({
      capabilityConsent: { pluginId: "diffs" },
    });
    expect(() => handler.applyAcceptedSurface("diffs", officialRecord)).toThrow(
      "did not expose its verified artifact",
    );
  });

  it("enables and reports a verified official install without legacy acceptance", async () => {
    const rootDir = officialArtifact();
    const record = { ...officialRecord, installPath: rootDir };
    const config = {
      plugins: { load: { paths: [rootDir] }, entries: { diffs: { enabled: true } } },
    };
    const env = discoveryEnv(rootDir);
    discoverMetadata({
      config,
      env,
      installRecords: { diffs: record },
    });
    expect(await consent({ config, env, pluginId: "diffs" })).toBeUndefined();
    expect(mocks.writeRecords).not.toHaveBeenCalled();
    const catalog = await listManagedPlugins({ config, env });
    expect(catalog.diagnostics).not.toContainEqual(
      expect.objectContaining({ message: expect.stringContaining("requires capability consent") }),
    );
  });

  it("rejects enabling an unaccepted plugin with only its reviewed-surface challenge", async () => {
    const record = installRecord();
    const snapshot = configureExternalPlugin(record);
    const manifest = snapshot.byPluginId.get("community-plugin")!;
    manifest.providers.push("community-provider");
    writeConsentArtifact(record.installPath!, "community-plugin", ["community-provider"]);

    await expect(
      setManagedPluginEnabled({ pluginId: "community-plugin", enabled: true, env: {} }),
    ).rejects.toMatchObject({
      capabilityConsent: {
        pluginId: "community-plugin",
        reviewToken: artifactReviewToken(record),
      },
      message: expect.stringContaining(
        "Rerun the openclaw plugins install, enable, update, or reload command with --accept-capabilities after reviewing the plugin.",
      ),
    });
    expect(mocks.replaceConfig).not.toHaveBeenCalled();
  });

  it("persists an interactive acknowledgment for a home-relative path and reuses it", async () => {
    const artifactDir = createConsentArtifact();
    const env = { HOME: path.dirname(artifactDir) };
    const installPath = `~/${path.basename(artifactDir)}`;
    const record = installRecord({ installPath });
    const snapshot = configureExternalPlugin(record);
    snapshot.index.plugins[0]!.rootDir = artifactDir;
    snapshot.byPluginId.get("community-plugin")!.rootDir = artifactDir;
    const reviewToken = computeDeclaredSurfaceHash(
      resolvePluginArtifactDeclaredSurface(artifactDir),
    );
    const onCapabilityConsent = vi.fn<PluginCapabilityConsentHandler>(async (review) => ({
      reviewToken: review.reviewToken,
    }));
    await consent({ env, onCapabilityConsent });

    const persisted = mocks.records["community-plugin"]!;
    expect(persisted).toMatchObject({
      installPath,
      acceptedSurfaceHash: reviewToken,
      acceptedSurfaceIntegrity: "sha512-verified-artifact",
      acceptedSurfaceAt: expect.any(String),
    });

    expect(await consent({ env, onCapabilityConsent })).toBeUndefined();
    expect(mocks.writeRecords).toHaveBeenCalledTimes(1);
    expect(onCapabilityConsent).toHaveBeenCalledTimes(1);
  });

  it("inspects the actual configured override and its package siblings before accepting either", async () => {
    const record = installRecord();
    const rootDir = record.installPath!;
    writeConsentArtifact(rootDir, "community-plugin", ["package-provider"]);
    for (const [directory, entry, provider] of [
      ["a", "first", "configured-provider"],
      ["b", "second", "ignored-provider"],
    ] as const) {
      const childDir = path.join(rootDir, directory);
      fs.mkdirSync(childDir);
      writeConsentArtifact(childDir, `${entry}-plugin`, [provider]);
      fs.writeFileSync(path.join(childDir, `${entry}.cjs`), "module.exports = {};");
    }
    fs.writeFileSync(
      path.join(rootDir, "package.json"),
      JSON.stringify({
        name: "community-plugin",
        openclaw: { extensions: ["./a/first.cjs", "./b/second.cjs"] },
      }),
    );
    const config = {
      plugins: {
        load: { paths: [path.join(rootDir, "a/first.cjs")] },
        entries: {
          "first-plugin": { enabled: false },
          "community-plugin/second": { enabled: false },
        },
      },
    };
    const env = discoveryEnv(rootDir);
    mocks.records = { "community-plugin": record };
    const manifests = discoverMetadata({ config, env, installRecords: mocks.records }, true);

    const inspections = await Promise.all(
      ["first-plugin", "community-plugin/second"].map((pluginId) =>
        inspect({ config, env, pluginId }),
      ),
    );
    const declared = resolvePluginArtifactDeclaredSurface(rootDir, env, { config });
    expect(declared.providers).toEqual(["configured-provider", "package-provider"]);
    const reviewToken = computeDeclaredSurfaceHash(declared);

    expect(inspections.map((inspection) => inspection.overview?.capabilities?.providers)).toEqual([
      ["configured-provider"],
      ["package-provider"],
    ]);
    for (const inspection of inspections) {
      expect(inspection.declared).toEqual(declared);
      expect(inspection.reviewToken).toBe(reviewToken);
      expect(
        await consent({
          config,
          env,
          pluginId: inspection.plugin.id,
          acknowledge: { reviewToken },
        }),
      ).toBeUndefined();
    }
    expect(mocks.records["community-plugin"]).toMatchObject({
      acceptedSurface: { providers: ["configured-provider", "package-provider"] },
      acceptedSurfaceHash: reviewToken,
    });
    expect(mocks.writeRecords).toHaveBeenCalledTimes(1);

    manifests.delete("community-plugin/second");
    await expect(inspect({ config, env, pluginId: "first-plugin" })).rejects.toThrow(
      "incomplete manifest metadata",
    );
  });

  it("rechecks the installed artifact after interactive consent yields", async () => {
    const record = installRecord();
    configureExternalPlugin(record);
    const reviewedToken = artifactReviewToken(record);
    const onCapabilityConsent = vi.fn<PluginCapabilityConsentHandler>(async (review) => {
      await Promise.resolve();
      writeConsentArtifact(record.installPath!, "community-plugin", ["unreviewed-provider"]);
      return { reviewToken: review.reviewToken };
    });

    await expect(consent({ onCapabilityConsent })).rejects.toMatchObject({
      capabilityConsent: { pluginId: "community-plugin" },
    });
    expect(onCapabilityConsent).toHaveBeenCalledWith(
      expect.objectContaining({ reviewToken: reviewedToken }),
    );
    expect(mocks.writeRecords).not.toHaveBeenCalled();
    const inspection = await inspect();
    expect(inspection.declared.providers).toEqual(["unreviewed-provider"]);
    expect(inspection.reviewToken).not.toBe(reviewedToken);
  });

  it("reports newly declared capabilities when the installed manifest outgrows acceptance", async () => {
    const previous = buildPluginCapabilitySummary({ manifest: {}, origin: "global" }).declared;
    const snapshot = configureExternalPlugin(
      installRecord({
        acceptedSurface: previous,
        acceptedSurfaceHash: computeDeclaredSurfaceHash(previous),
        acceptedSurfaceIntegrity: "sha512-verified-artifact",
        acceptedSurfaceAt: "2026-08-25T00:00:00.000Z",
      }),
    );
    snapshot.byPluginId.get("community-plugin")!.providers.push("new-provider");
    writeConsentArtifact(mocks.records["community-plugin"]!.installPath!, "community-plugin", [
      "new-provider",
    ]);

    await expect(consent()).rejects.toMatchObject({
      capabilityConsent: {
        widened: { providers: ["new-provider"] },
        acceptedAt: "2026-08-25T00:00:00.000Z",
      },
    });
  });

  it("fails closed when an installed plugin has ambiguous package ownership", async () => {
    const snapshot = configureExternalPlugin(installRecord());
    recordInstalledPluginIndexInstallOwner(snapshot.index.plugins[0]!, undefined, true);

    await expect(consent()).rejects.toThrow("ambiguous package ownership");
    expect(mocks.writeRecords).not.toHaveBeenCalled();
  });

  it("retains a rejected community install for inspection and refreshes stale reviews", async () => {
    mocks.metadata.mockReturnValue(emptyMetadataSnapshot());
    const artifactDir = createConsentArtifact();
    const firstReviewToken = computeDeclaredSurfaceHash(
      resolvePluginArtifactDeclaredSurface(artifactDir),
    );
    const firstHandler = artifactHandler({ spec: "community-plugin" });

    await expect(
      firstHandler.onBeforePluginArtifactCommit(stagedArtifact(artifactDir, "community-plugin")),
    ).rejects.toMatchObject({
      capabilityConsent: { pluginId: "community-plugin", reviewToken: firstReviewToken },
    });

    const firstInspection = await inspect();
    expect(firstInspection).toMatchObject({
      plugin: { id: "community-plugin", name: "Community Plugin", installed: false },
      declared: { providers: [] },
      reviewToken: firstReviewToken,
    });

    writeConsentArtifact(artifactDir, "community-plugin", ["unreviewed-provider"]);
    const refreshedToken = computeDeclaredSurfaceHash(
      resolvePluginArtifactDeclaredSurface(artifactDir),
    );
    const staleHandler = artifactHandler({
      spec: "community-plugin",
      acknowledgeCapabilities: { reviewToken: firstReviewToken },
    });

    await expect(
      staleHandler.onBeforePluginArtifactCommit(stagedArtifact(artifactDir, "community-plugin")),
    ).rejects.toMatchObject({
      capabilityConsent: { pluginId: "community-plugin", reviewToken: refreshedToken },
    });
    expect(await inspect()).toMatchObject({
      declared: { providers: ["unreviewed-provider"] },
      reviewToken: refreshedToken,
    });
  });
});

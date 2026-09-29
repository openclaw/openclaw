// Missing configured plugin install tests cover doctor diagnostics for absent plugin installs.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, expect, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/types.js";
import { resolveRegistryUpdateChannel } from "../../../infra/update-channels.js";
import { resolveClawHubInstallSpecsForUpdateChannel } from "../../../plugins/install-channel-specs.js";
import { createPluginMetadataSnapshotFixture } from "../../../plugins/plugin-metadata.test-support.js";
import type { BundledProviderPolicySurface } from "../../../plugins/provider-policy-surface.js";
import { resolveOpenClawStateSqlitePath } from "../../../state/openclaw-state-db.paths.js";
import { expectObjectFields } from "../../../test-utils/mock-call-assertions.js";
import { VERSION } from "../../../version.js";
import {
  brokenPluginSnapshot,
  installedRecords,
  officialWebSearchPluginEntry,
  setupPluginInstallTestState,
} from "./missing-configured-plugin-install.test-helpers.js";

function expectedNpmInstallSpec(spec: string): string {
  return resolveRegistryUpdateChannel({ currentVersion: VERSION }) === "beta"
    ? `${spec}@${VERSION}`
    : spec;
}

function expectedClawHubInstallSpec(spec: string): string {
  return resolveClawHubInstallSpecsForUpdateChannel({
    spec,
    updateChannel: resolveRegistryUpdateChannel({ currentVersion: VERSION }),
  }).installSpec;
}

function expectedCodexInstallSpec(): string {
  return `@openclaw/codex@${VERSION}`;
}

function mockNpmRegistryTags(tags: { beta?: string; latest: string }): void {
  mocks.resolveNpmSpecMetadata.mockImplementation(async ({ spec }: { spec: string }) => {
    const selectorIndex = spec.lastIndexOf("@");
    const name = spec.slice(0, selectorIndex);
    const tag = spec.slice(selectorIndex + 1);
    const version = tag === "beta" ? tags.beta : tags.latest;
    return version
      ? { ok: true, metadata: { name, version, resolvedSpec: `${name}@${version}` } }
      : { ok: false, error: `No ${tag} release for ${name}.` };
  });
}

function expectRecordFields(record: unknown, expected: Record<string, unknown>) {
  if (!record || typeof record !== "object") {
    throw new Error("Expected record");
  }
  const actual = record as Record<string, unknown>;
  expectObjectFields(actual, expected);
  return actual;
}

function mockCallArg(mock: ReturnType<typeof vi.fn>, callIndex = 0, argIndex = 0) {
  const call = mock.mock.calls[callIndex];
  if (!call) {
    throw new Error(`Expected mock call ${callIndex}`);
  }
  return call[argIndex];
}

function expectedIndexWriteOptions(config: unknown, env: NodeJS.ProcessEnv) {
  const databasePath = resolveOpenClawStateSqlitePath(env);
  return {
    config,
    env,
    filePath: databasePath,
    lease: expect.objectContaining({
      databasePath,
      assertOwned: expect.any(Function),
      assertOwnedInTransaction: expect.any(Function),
    }),
  };
}

const mocks = vi.hoisted(() => ({
  installPluginFromClawHub: vi.fn(),
  installPluginFromNpmSpec: vi.fn(),
  listChannelPluginCatalogEntries: vi.fn(),
  listOfficialExternalChannelEnvVars: vi.fn(() => []),
  listOfficialExternalPluginCatalogEntries: vi.fn(),
  loadPluginManifestRegistryCore: vi.fn(),
  loadInstalledPluginIndexInstallRecords: vi.fn(),
  loadPluginMetadataSnapshot: vi.fn(),
  getOfficialExternalPluginCatalogManifest: vi.fn(
    (entry: { openclaw?: unknown }) => entry.openclaw,
  ),
  resolveOfficialExternalPluginId: vi.fn((entry: { id?: string }) => entry.id),
  resolveOfficialExternalPluginInstall: vi.fn(
    (entry: { install?: unknown }) => entry.install ?? null,
  ),
  resolveOfficialExternalPluginLabel: vi.fn(
    (entry: { label?: string; id?: string }) => entry.label ?? entry.id ?? "plugin",
  ),
  resolveOfficialExternalProviderContractPluginIds: vi.fn(),
  resolveOfficialExternalProviderPluginIds: vi.fn(),
  resolveOfficialExternalProviderPluginIdsForEnv: vi.fn(),
  resolveOfficialExternalWebProviderContractPluginIdsForEnv: vi.fn(),
  resolveDirectBundledProviderPolicySurface: vi.fn(
    (pluginId: string): BundledProviderPolicySurface | null =>
      pluginId === "openai"
        ? {
            normalizeModelCatalogId: ({ modelId }) => modelId,
            resolveModelRoutes: ({ requestTransportOverrides }) => ({
              kind: "routes",
              routes: [
                {
                  api: "openai-responses",
                  baseUrl: "https://api.openai.com/v1",
                  authRequirement: "api-key",
                  requestTransportOverrides: requestTransportOverrides ?? "none",
                  runtimePolicy: { compatibleIds: ["openclaw", "codex"] },
                },
              ],
              defaultRuntimeId: "codex",
            }),
          }
        : null,
  ),
  resolveDefaultPluginExtensionsDir: vi.fn(() => "/tmp/openclaw-plugins"),
  resolveDefaultPluginNpmDir: vi.fn(() => "/tmp/openclaw-npm"),
  resolvePluginNpmProjectsDir: vi.fn((npmDir = "/tmp/openclaw-npm") =>
    path.join(npmDir, "projects"),
  ),
  resolvePluginNpmPackageDir: vi.fn(
    ({ npmDir, packageName }: { npmDir?: string; packageName: string }) =>
      path.join(
        npmDir ?? "/tmp/openclaw-npm",
        "projects",
        packageName.replace(/[^a-zA-Z0-9._-]+/g, "-"),
        "node_modules",
        ...packageName.split("/"),
      ),
  ),
  resolvePluginInstallDir: vi.fn(
    (pluginId: string, extensionsDir = "/tmp/openclaw-plugins") => `${extensionsDir}/${pluginId}`,
  ),
  validatePluginId: vi.fn(() => null),
  resolveProviderInstallCatalogEntries: vi.fn(),
  resolveNpmSpecMetadata: vi.fn(),
  updateNpmInstalledPlugins: vi.fn(),
  writePersistedInstalledPluginIndexInstallRecordsWithLease:
    vi.fn<
      typeof import("../../../plugins/installed-plugin-index-records.js").writePersistedInstalledPluginIndexInstallRecordsWithLease
    >(),
}));

const { testEnv, tempDirs } = setupPluginInstallTestState();

const prepareManagedPluginArtifactConsentHandler = vi.hoisted(() =>
  vi.fn<
    typeof import("../../../plugins/capability-consent.js").prepareManagedPluginArtifactConsentHandler
  >(),
);
vi.mock("../../../plugins/capability-consent.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../plugins/capability-consent.js")>()),
  prepareManagedPluginArtifactConsentHandler,
}));

function mockCurrentBundledPlugin(
  pluginId: string,
  packageName: string,
  rootDir = `/tmp/bundled/${pluginId}`,
): void {
  mocks.loadPluginManifestRegistryCore.mockReturnValue({
    plugins: [{ id: pluginId, origin: "bundled", packageName, rootDir }],
    diagnostics: [],
  });
}

function writeLegacyNpmDeclarationStub(params: {
  pluginDir: string;
  pluginId: string;
  npmSpec: string;
}): void {
  fs.mkdirSync(params.pluginDir, { recursive: true });
  fs.writeFileSync(
    path.join(params.pluginDir, "openclaw.extension.json"),
    JSON.stringify({
      name: params.pluginId,
      type: "npm",
      npmSpec: params.npmSpec,
    }),
    "utf8",
  );
}

async function repairConfiguredPlugins(
  cfg: OpenClawConfig,
  env: Record<string, string | undefined> = {},
) {
  const { repairMissingConfiguredPluginInstalls } =
    await import("./missing-configured-plugin-install.js");
  return repairMissingConfiguredPluginInstalls({ cfg, env: { ...testEnv, ...env } });
}

async function useRealInstallIndexWrites() {
  const actual = await vi.importActual<
    typeof import("../../../plugins/installed-plugin-index-records.js")
  >("../../../plugins/installed-plugin-index-records.js");
  mocks.writePersistedInstalledPluginIndexInstallRecordsWithLease.mockImplementation(
    (records, options) =>
      actual.writePersistedInstalledPluginIndexInstallRecordsWithLease(records, {
        ...options,
        candidates: [],
      }),
  );
}

function useManifestCatalogResolvers(): void {
  mocks.resolveOfficialExternalPluginId.mockImplementation(
    (entry: { id?: string; openclaw?: { plugin?: { id?: string } } }) =>
      entry.openclaw?.plugin?.id ?? entry.id,
  );
  mocks.resolveOfficialExternalPluginInstall.mockImplementation(
    (entry: { install?: unknown; openclaw?: { install?: unknown } }) =>
      entry.openclaw?.install ?? entry.install ?? null,
  );
  mocks.resolveOfficialExternalPluginLabel.mockImplementation(
    (entry: { label?: string; openclaw?: { plugin?: { label?: string } } }) =>
      entry.openclaw?.plugin?.label ?? entry.label ?? "plugin",
  );
}

function mockBrokenBraveInstall(
  installDir: string,
  recordOverrides: Record<string, unknown>,
): Record<string, Record<string, unknown>> {
  const records = installedRecords("brave", {
    installPath: installDir,
    ...recordOverrides,
  });
  mocks.loadInstalledPluginIndexInstallRecords.mockResolvedValue(records);
  mocks.loadPluginMetadataSnapshot.mockReturnValue(brokenPluginSnapshot("brave", installDir));
  mocks.listOfficialExternalPluginCatalogEntries.mockReturnValue([
    officialWebSearchPluginEntry({
      id: "brave",
      npmSpec: "@openclaw/brave-plugin",
      envVar: "BRAVE_API_KEY",
      label: "Brave",
      providerLabel: "Brave Search",
    }),
  ]);
  return records;
}

vi.mock("../../../channels/plugins/catalog.js", () => ({
  listRawChannelPluginCatalogEntries: mocks.listChannelPluginCatalogEntries,
}));

vi.mock("../../../plugins/installed-plugin-index-records.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../plugins/installed-plugin-index-records.js")>()),
  loadInstalledPluginIndexInstallRecords: mocks.loadInstalledPluginIndexInstallRecords,
  writePersistedInstalledPluginIndexInstallRecordsWithLease:
    mocks.writePersistedInstalledPluginIndexInstallRecordsWithLease,
}));

vi.mock("../../../plugins/manifest-registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../plugins/manifest-registry.js")>();
  return {
    ...actual,
    loadPluginManifestRegistryCore: (
      params: Parameters<typeof actual.loadPluginManifestRegistryCore>[0],
    ) => {
      // Staged consent inspects real artifact manifests, not the synthetic bundled inventory.
      if (
        params?.candidates !== undefined ||
        params?.discovery !== undefined ||
        !params?.installRecords ||
        Object.keys(params.installRecords).length > 0
      ) {
        return actual.loadPluginManifestRegistryCore(params);
      }
      return mocks.loadPluginManifestRegistryCore(params);
    },
  };
});

vi.mock("../../../plugins/install-paths.js", () => ({
  resolveDefaultPluginExtensionsDir: mocks.resolveDefaultPluginExtensionsDir,
  resolveDefaultPluginNpmDir: mocks.resolveDefaultPluginNpmDir,
  resolvePluginNpmProjectsDir: mocks.resolvePluginNpmProjectsDir,
  resolvePluginNpmPackageDir: mocks.resolvePluginNpmPackageDir,
  resolvePluginInstallDir: mocks.resolvePluginInstallDir,
  validatePluginId: mocks.validatePluginId,
}));

vi.mock("../../../plugins/install.js", () => ({
  installPluginFromNpmSpec: mocks.installPluginFromNpmSpec,
}));

vi.mock("../../../infra/install-source-utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../infra/install-source-utils.js")>()),
  resolveNpmSpecMetadata: mocks.resolveNpmSpecMetadata,
}));

vi.mock("../../../plugins/clawhub.js", () => ({
  CLAWHUB_INSTALL_ERROR_CODE: {
    PACKAGE_NOT_FOUND: "package_not_found",
    VERSION_NOT_FOUND: "version_not_found",
    ARTIFACT_UNAVAILABLE: "artifact_unavailable",
    ARTIFACT_DOWNLOAD_UNAVAILABLE: "artifact_download_unavailable",
    CLAWHUB_DOWNLOAD_BLOCKED: "clawhub_download_blocked",
    CLAWHUB_SECURITY_UNAVAILABLE: "clawhub_security_unavailable",
  },
  installPluginFromClawHub: mocks.installPluginFromClawHub,
}));

vi.mock("../../../plugins/plugin-metadata-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../plugins/plugin-metadata-snapshot.js")>()),
  loadPluginMetadataSnapshot: mocks.loadPluginMetadataSnapshot,
  resolvePluginMetadataSnapshot: mocks.loadPluginMetadataSnapshot,
}));

vi.mock("../../../plugins/manifest-contract-eligibility.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../plugins/manifest-contract-eligibility.js")>()),
  loadManifestMetadataSnapshot: () => ({
    ...mocks.loadPluginMetadataSnapshot(),
    index: createPluginMetadataSnapshotFixture(mocks.loadPluginManifestRegistryCore()).index,
  }),
}));

vi.mock("../../../plugins/official-external-plugin-catalog.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../../plugins/official-external-plugin-catalog.js")
  >()),
  getOfficialExternalPluginCatalogManifest: mocks.getOfficialExternalPluginCatalogManifest,
  listOfficialExternalChannelEnvVars: mocks.listOfficialExternalChannelEnvVars,
  listOfficialExternalPluginCatalogEntries: mocks.listOfficialExternalPluginCatalogEntries,
  resolveOfficialExternalPluginId: mocks.resolveOfficialExternalPluginId,
  resolveOfficialExternalPluginInstall: mocks.resolveOfficialExternalPluginInstall,
  resolveOfficialExternalPluginLabel: mocks.resolveOfficialExternalPluginLabel,
  resolveOfficialExternalProviderContractPluginIds:
    mocks.resolveOfficialExternalProviderContractPluginIds,
  resolveOfficialExternalProviderPluginIds: mocks.resolveOfficialExternalProviderPluginIds,
  resolveOfficialExternalProviderPluginIdsForEnv:
    mocks.resolveOfficialExternalProviderPluginIdsForEnv,
  resolveOfficialExternalWebProviderContractPluginIdsForEnv:
    mocks.resolveOfficialExternalWebProviderContractPluginIdsForEnv,
}));

vi.mock("../../../plugins/provider-install-catalog.js", () => ({
  resolveProviderInstallCatalogEntries: mocks.resolveProviderInstallCatalogEntries,
}));

vi.mock("../../../plugins/provider-policy-surface.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../plugins/provider-policy-surface.js")>()),
  // This suite owns install repair. Provider artifact loading and route policy
  // have dedicated tests, so keep the OpenAI runtime-selection seam in memory.
  resolveDirectBundledProviderPolicySurface: mocks.resolveDirectBundledProviderPolicySurface,
}));

vi.mock("../../../plugins/doctor-contract-registry.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../plugins/doctor-contract-registry.js")>();
  return {
    ...actual,
    // Plugin-owned compatibility discovery has its own coverage. Keep this
    // install-repair suite focused and avoid scanning every source plugin.
    applyPluginDoctorCompatibilityMigrations: (cfg: OpenClawConfig) => ({
      config: cfg,
      changes: [],
    }),
  };
});

vi.mock("../../../plugins/update.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../plugins/update.js")>();
  return {
    ...actual,
    updateNpmInstalledPlugins: mocks.updateNpmInstalledPlugins,
  };
});

export function setupPluginInstallSuite() {
  beforeAll(async () => {
    // The doctor module owns a broad install/catalog graph. Its cold import is
    // suite setup; individual cases measure detection and repair behavior.
    await import("./missing-configured-plugin-install.js");
  });

  beforeEach(() => {
    vi.clearAllMocks();
    // Existing cases observe record/config projection; fence cases use the real SQLite writer.
    mocks.writePersistedInstalledPluginIndexInstallRecordsWithLease.mockReset();
    mockNpmRegistryTags({ beta: VERSION, latest: VERSION });
    // Explicit empty env fixtures fall back to the OS home, outside Vitest's env copy.
    vi.spyOn(os, "homedir").mockReturnValue(tempDirs.make("openclaw-doctor-home-"));
    prepareManagedPluginArtifactConsentHandler.mockResolvedValue({
      onBeforePluginArtifactCommit: async () => {},
      applyAcceptedSurface: (_pluginId, record) => record,
    });
    mocks.loadPluginMetadataSnapshot.mockReturnValue({
      plugins: [],
      diagnostics: [],
    });
    mocks.loadPluginManifestRegistryCore.mockReturnValue({
      plugins: [],
      diagnostics: [],
    });
    mocks.loadInstalledPluginIndexInstallRecords.mockResolvedValue({});
    mocks.listChannelPluginCatalogEntries.mockReturnValue([]);
    mocks.listOfficialExternalPluginCatalogEntries.mockReturnValue([]);
    mocks.resolveDefaultPluginExtensionsDir.mockReturnValue("/tmp/openclaw-plugins");
    mocks.resolveDefaultPluginNpmDir.mockReturnValue("/tmp/openclaw-npm");
    mocks.resolveProviderInstallCatalogEntries.mockReturnValue([]);
    mocks.resolveOfficialExternalProviderPluginIdsForEnv.mockReturnValue([]);
    mocks.resolveOfficialExternalWebProviderContractPluginIdsForEnv.mockReturnValue([]);
    mocks.resolveOfficialExternalProviderContractPluginIds.mockImplementation(
      ({ contract, providerIds }: { contract: string; providerIds: ReadonlySet<string> }) => {
        const configuredProviderIds = new Set(
          [...providerIds].map((providerId) => providerId.trim().toLowerCase()),
        );
        const entries = mocks.listOfficialExternalPluginCatalogEntries.getMockImplementation()?.();
        if (!Array.isArray(entries)) {
          return [];
        }
        return entries.flatMap((entry) => {
          if (!entry || typeof entry !== "object") {
            return [];
          }
          const candidate = entry as {
            id?: string;
            openclaw?: {
              plugin?: { id?: string };
              contracts?: Record<string, unknown>;
            };
          };
          const pluginId = candidate.openclaw?.plugin?.id ?? candidate.id;
          const ownedProviderIds = candidate.openclaw?.contracts?.[contract];
          if (
            !pluginId ||
            !Array.isArray(ownedProviderIds) ||
            !ownedProviderIds.some(
              (providerId) =>
                typeof providerId === "string" &&
                configuredProviderIds.has(providerId.trim().toLowerCase()),
            )
          ) {
            return [];
          }
          return [pluginId];
        });
      },
    );
    mocks.resolveOfficialExternalProviderPluginIds.mockImplementation(
      ({ providerIds }: { providerIds: ReadonlySet<string> }) => {
        const configuredProviderIds = new Set(
          [...providerIds].map((providerId) => providerId.trim().toLowerCase()),
        );
        const entries = mocks.listOfficialExternalPluginCatalogEntries.getMockImplementation()?.();
        if (!Array.isArray(entries)) {
          return [];
        }
        return entries.flatMap((entry) => {
          if (!entry || typeof entry !== "object") {
            return [];
          }
          const candidate = entry as {
            id?: string;
            openclaw?: {
              plugin?: { id?: string };
              providers?: Array<{ id?: string; aliases?: string[] }>;
            };
          };
          const pluginId = candidate.openclaw?.plugin?.id ?? candidate.id;
          const ownsConfiguredProvider = candidate.openclaw?.providers?.some((provider) =>
            [provider.id, ...(provider.aliases ?? [])].some(
              (providerId) =>
                typeof providerId === "string" &&
                configuredProviderIds.has(providerId.trim().toLowerCase()),
            ),
          );
          return pluginId && ownsConfiguredProvider ? [pluginId] : [];
        });
      },
    );
    mocks.installPluginFromClawHub.mockResolvedValue({
      ok: true,
      pluginId: "matrix",
      targetDir: "/tmp/openclaw-plugins/matrix",
      version: "1.2.3",
      clawhub: {
        source: "clawhub",
        clawhubUrl: "https://clawhub.ai",
        clawhubPackage: "@openclaw/plugin-matrix",
        clawhubFamily: "code-plugin",
        clawhubChannel: "official",
        version: "1.2.3",
        integrity: "sha256-clawhub",
        resolvedAt: "2026-05-01T00:00:00.000Z",
        clawpackSha256: "0".repeat(64),
        clawpackSpecVersion: 1,
        clawpackManifestSha256: "1".repeat(64),
        clawpackSize: 1234,
      },
    });
    mocks.installPluginFromNpmSpec.mockReset();
    mocks.installPluginFromNpmSpec.mockResolvedValue({
      ok: true,
      pluginId: "matrix",
      targetDir: "/tmp/openclaw-plugins/matrix",
      version: "1.2.3",
      npmResolution: {
        name: "@openclaw/plugin-matrix",
        version: "1.2.3",
        resolvedSpec: "@openclaw/plugin-matrix@1.2.3",
        integrity: "sha512-test",
        resolvedAt: "2026-05-01T00:00:00.000Z",
      },
    });
  });

  afterEach(() => vi.restoreAllMocks());
}

export {
  expectedNpmInstallSpec,
  expectedClawHubInstallSpec,
  expectedCodexInstallSpec,
  mockNpmRegistryTags,
  expectRecordFields,
  mockCallArg,
  expectedIndexWriteOptions,
  mockCurrentBundledPlugin,
  writeLegacyNpmDeclarationStub,
  repairConfiguredPlugins,
  useRealInstallIndexWrites,
  useManifestCatalogResolvers,
  mockBrokenBraveInstall,
  mocks,
  testEnv,
  tempDirs,
  prepareManagedPluginArtifactConsentHandler,
};

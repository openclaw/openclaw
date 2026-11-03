import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, expect, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/types.js";
import { resolveRegistryUpdateChannel } from "../../../infra/update-channels.js";
import { resolveClawHubInstallSpecsForUpdateChannel } from "../../../plugins/install-channel-specs.js";
import { createPluginMetadataSnapshotFixture } from "../../../plugins/plugin-metadata.test-support.js";
import { resolveOpenClawStateSqlitePath } from "../../../state/openclaw-state-db.paths.js";
import { mockCall } from "../../../test-utils/mock-call-assertions.js";
import { VERSION } from "../../../version.js";
import type { openaiPolicySurface } from "./missing-configured-plugin-install.fixtures.test-support.js";
import {
  brokenPluginSnapshot,
  installedRecords,
  officialWebSearchPluginEntry,
  setupPluginInstallTestState,
  successfulInstall,
} from "./missing-configured-plugin-install.test-helpers.js";
export { expectObjectFields as expectRecordFields } from "../../../test-utils/mock-call-assertions.js";

export function expectedNpmInstallSpec(spec: string): string {
  return resolveRegistryUpdateChannel({ currentVersion: VERSION }) === "beta"
    ? `${spec}@${VERSION}`
    : spec;
}

export function expectedClawHubInstallSpec(spec: string): string {
  return resolveClawHubInstallSpecsForUpdateChannel({
    spec,
    updateChannel: resolveRegistryUpdateChannel({ currentVersion: VERSION }),
  }).installSpec;
}

export function expectedCodexInstallSpec(): string {
  return `@openclaw/codex@${VERSION}`;
}

export function mockNpmRegistryTags(tags: { beta?: string; latest: string }): void {
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

export function mockCallArg(mock: ReturnType<typeof vi.fn>, callIndex = 0, argIndex = 0) {
  return mockCall(mock, callIndex)[argIndex];
}

export function expectedIndexWriteOptions(config: unknown, env: NodeJS.ProcessEnv) {
  const databasePath = resolveOpenClawStateSqlitePath(env);
  return {
    config,
    env,
    filePath: databasePath,
    lease: expect.objectContaining({
      databasePath,
      assertOwned: expect.any(Function),
      assertCurrent: expect.any(Function),
      stateLease: expect.objectContaining({ assertCurrent: expect.any(Function) }),
    }),
  };
}

const catalogMocks = vi.hoisted(() => ({
  listOfficialExternalChannelEnvVars: vi.fn(() => []),
  listOfficialExternalPluginCatalogEntries: vi.fn(),
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
}));
const installPathMocks = vi.hoisted(() => ({
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
}));
const mocks = vi.hoisted(() => ({
  ...catalogMocks,
  ...installPathMocks,
  installPluginFromClawHub: vi.fn(),
  installPluginFromNpmSpec: vi.fn(),
  listChannelPluginCatalogEntries: vi.fn(),
  loadPluginManifestRegistryCore: vi.fn(),
  loadInstalledPluginIndexInstallRecords: vi.fn(),
  loadPluginMetadataSnapshot: vi.fn(),
  resolveDirectBundledProviderPolicySurface: vi.fn<typeof openaiPolicySurface>(),
  resolveProviderInstallCatalogEntries: vi.fn(),
  resolveNpmSpecMetadata: vi.fn(),
  updateNpmInstalledPlugins: vi.fn(),
  writePersistedInstalledPluginIndexInstallRecordsWithLease:
    vi.fn<
      typeof import("../../../plugins/installed-plugin-index-records.js").writePersistedInstalledPluginIndexInstallRecordsWithLease
    >(),
}));

export const { testEnv, tempDirs } = setupPluginInstallTestState();

const prepareManagedPluginArtifactConsentHandler = vi.hoisted(() =>
  vi.fn<
    typeof import("../../../plugins/capability-consent.js").prepareManagedPluginArtifactConsentHandler
  >(),
);
vi.mock("../../../plugins/capability-consent.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../plugins/capability-consent.js")>()),
  prepareManagedPluginArtifactConsentHandler,
}));

export function mockCurrentBundledPlugin(
  pluginId: string,
  packageName: string,
  rootDir = `/tmp/bundled/${pluginId}`,
): void {
  mocks.loadPluginManifestRegistryCore.mockReturnValue({
    plugins: [{ id: pluginId, origin: "bundled", packageName, rootDir }],
    diagnostics: [],
  });
}

export async function repairConfiguredPlugins(
  cfg: OpenClawConfig,
  env: Record<string, string | undefined> = {},
) {
  const { repairMissingConfiguredPluginInstalls } =
    await import("./missing-configured-plugin-install.js");
  return repairMissingConfiguredPluginInstalls({ cfg, env: { ...testEnv, ...env } });
}

export async function useRealInstallIndexWrites() {
  const { writePersistedInstalledPluginIndexInstallRecordsWithLease: write } =
    await vi.importActual<typeof import("../../../plugins/installed-plugin-index-records.js")>(
      "../../../plugins/installed-plugin-index-records.js",
    );
  mocks.writePersistedInstalledPluginIndexInstallRecordsWithLease.mockImplementation(
    (records, options) => write(records, { ...options, candidates: [] }),
  );
}

export function useManifestCatalogResolvers(): void {
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

export function mockBrokenBraveInstall(
  installDir: string,
  recordOverrides: Record<string, unknown>,
): Record<string, Record<string, unknown>> {
  const records = installedRecords("brave", { installPath: installDir, ...recordOverrides });
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

type TestCatalogEntry = {
  id?: string;
  openclaw?: {
    plugin?: { id?: string };
    contracts?: Record<string, unknown>;
    providers?: Array<{ id?: string; aliases?: string[] }>;
  };
};

function catalogPluginIds(
  providerIds: ReadonlySet<string>,
  ownedIds: (entry: TestCatalogEntry) => unknown,
) {
  const configured = new Set([...providerIds].map((id) => id.trim().toLowerCase()));
  const entries = mocks.listOfficialExternalPluginCatalogEntries.getMockImplementation()?.();
  if (!Array.isArray(entries)) {
    return [];
  }
  return entries.flatMap((entry) => {
    if (!entry || typeof entry !== "object") {
      return [];
    }
    const candidate = entry as TestCatalogEntry;
    const id = candidate.openclaw?.plugin?.id ?? candidate.id;
    const providers = ownedIds(candidate);
    return id &&
      Array.isArray(providers) &&
      providers.some(
        (provider) => typeof provider === "string" && configured.has(provider.trim().toLowerCase()),
      )
      ? [id]
      : [];
  });
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
      return params?.candidates !== undefined ||
        params?.discovery !== undefined ||
        !params?.installRecords ||
        Object.keys(params.installRecords).length > 0
        ? actual.loadPluginManifestRegistryCore(params)
        : mocks.loadPluginManifestRegistryCore(params);
    },
  };
});

// mock-isolation: resolve installs into the fixture's private plugin roots.
vi.mock("../../../plugins/install-paths.js", () => installPathMocks);

vi.mock("../../../plugins/install.js", () => ({
  installPluginFromNpmSpec: mocks.installPluginFromNpmSpec,
}));

vi.mock("../../../infra/install-source-utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../infra/install-source-utils.js")>()),
  resolveNpmSpecMetadata: mocks.resolveNpmSpecMetadata,
}));

vi.mock("../../../plugins/clawhub.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../plugins/clawhub.js")>()),
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
  ...catalogMocks,
}));

vi.mock("../../../plugins/provider-install-catalog.js", () => ({
  resolveProviderInstallCatalogEntries: mocks.resolveProviderInstallCatalogEntries,
}));

vi.mock("../../../plugins/provider-policy-surface.js", async (importOriginal) => {
  const { openaiPolicySurface } =
    await import("./missing-configured-plugin-install.fixtures.test-support.js");
  mocks.resolveDirectBundledProviderPolicySurface.mockImplementation(openaiPolicySurface);
  return {
    ...(await importOriginal<typeof import("../../../plugins/provider-policy-surface.js")>()),
    resolveDirectBundledProviderPolicySurface: mocks.resolveDirectBundledProviderPolicySurface,
  };
});

vi.mock("../../../plugins/doctor-contract-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../plugins/doctor-contract-registry.js")>()),
  // Compatibility discovery has its own suite; avoid scanning every source plugin here.
  applyPluginDoctorCompatibilityMigrations: (config: OpenClawConfig) => ({ config, changes: [] }),
}));

vi.mock("../../../plugins/update.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../plugins/update.js")>()),
  updateNpmInstalledPlugins: mocks.updateNpmInstalledPlugins,
}));

export function setupPluginInstallSuite() {
  // Cold imports belong to suite setup, outside individual case budgets.
  beforeAll(() => import("./missing-configured-plugin-install.js"));

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
    mocks.loadPluginMetadataSnapshot.mockReturnValue({ plugins: [], diagnostics: [] });
    mocks.loadPluginManifestRegistryCore.mockReturnValue({ plugins: [], diagnostics: [] });
    mocks.loadInstalledPluginIndexInstallRecords.mockResolvedValue({});
    mocks.listChannelPluginCatalogEntries.mockReturnValue([]);
    mocks.listOfficialExternalPluginCatalogEntries.mockReturnValue([]);
    mocks.resolveDefaultPluginExtensionsDir.mockReturnValue("/tmp/openclaw-plugins");
    mocks.resolveDefaultPluginNpmDir.mockReturnValue("/tmp/openclaw-npm");
    mocks.resolveProviderInstallCatalogEntries.mockReturnValue([]);
    mocks.resolveOfficialExternalProviderPluginIdsForEnv.mockReturnValue([]);
    mocks.resolveOfficialExternalWebProviderContractPluginIdsForEnv.mockReturnValue([]);
    mocks.resolveOfficialExternalProviderContractPluginIds.mockImplementation(
      ({ contract, providerIds }: { contract: string; providerIds: ReadonlySet<string> }) =>
        catalogPluginIds(providerIds, (entry) => entry.openclaw?.contracts?.[contract]),
    );
    mocks.resolveOfficialExternalProviderPluginIds.mockImplementation(
      ({ providerIds }: { providerIds: ReadonlySet<string> }) =>
        catalogPluginIds(providerIds, (entry) =>
          entry.openclaw?.providers?.flatMap(({ id, aliases = [] }) => [id, ...aliases]),
        ),
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
      },
    });
    mocks.installPluginFromNpmSpec.mockReset().mockResolvedValue(
      successfulInstall({
        pluginId: "matrix",
        npmSpec: "@openclaw/plugin-matrix",
        version: "1.2.3",
        resolution: { integrity: "sha512-test" },
      }),
    );
  });

  afterEach(() => vi.restoreAllMocks());
}

export { mocks, prepareManagedPluginArtifactConsentHandler };

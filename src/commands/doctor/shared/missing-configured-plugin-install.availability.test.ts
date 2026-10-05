import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { withIsolatedTestHome } from "../../../../test/test-env.js";
import type { OpenClawConfigWithLegacyRoster } from "../../../config/legacy.roster.js";
import type { PluginInstallRecord } from "../../../config/types.plugins.js";
import { createPluginMetadataSnapshotFixture } from "../../../plugins/plugin-metadata.test-support.js";
import type { BundledProviderPolicySurface } from "../../../plugins/provider-policy-surface.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../../../state/openclaw-state-db-cache.js";
import { resolveOpenClawStateSqlitePath } from "../../../state/openclaw-state-db.paths.js";
import { VERSION } from "../../../version.js";

const mocks = vi.hoisted(() => ({
  installPluginFromClawHub: vi.fn(),
  installPluginFromNpmSpec: vi.fn(),
  loadInstalledPluginIndexInstallRecords: vi.fn(),
  loadManifestMetadataSnapshot: vi.fn(),
  listOfficialExternalPluginCatalogEntries: vi.fn(),
  updateNpmInstalledPlugins: vi.fn(),
  resolveNpmSpecMetadata: vi.fn(),
  writePersistedInstalledPluginIndexInstallRecordsWithLease:
    vi.fn<
      typeof import("../../../plugins/installed-plugin-index-records.js").writePersistedInstalledPluginIndexInstallRecordsWithLease
    >(),
}));

vi.mock("../../../infra/install-source-utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../infra/install-source-utils.js")>()),
  resolveNpmSpecMetadata: mocks.resolveNpmSpecMetadata,
}));
vi.mock("../../../plugins/clawhub.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../plugins/clawhub.js")>()),
  installPluginFromClawHub: mocks.installPluginFromClawHub,
}));
vi.mock("../../../plugins/install.js", () => ({
  installPluginFromNpmSpec: mocks.installPluginFromNpmSpec,
}));
vi.mock("../../../plugins/update.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../plugins/update.js")>()),
  updateNpmInstalledPlugins: mocks.updateNpmInstalledPlugins,
}));
vi.mock("../../../plugins/installed-plugin-index-records.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../plugins/installed-plugin-index-records.js")>()),
  loadInstalledPluginIndexInstallRecords: mocks.loadInstalledPluginIndexInstallRecords,
  writePersistedInstalledPluginIndexInstallRecordsWithLease:
    mocks.writePersistedInstalledPluginIndexInstallRecordsWithLease,
}));
vi.mock("../../../plugins/manifest-contract-eligibility.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../plugins/manifest-contract-eligibility.js")>()),
  loadManifestMetadataSnapshot: mocks.loadManifestMetadataSnapshot,
}));
vi.mock("../../../plugins/manifest-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../plugins/manifest-registry.js")>()),
  loadPluginManifestRegistryCore: () => ({ plugins: [], diagnostics: [] }),
}));
vi.mock("../../../channels/plugins/catalog.js", () => ({
  listRawChannelPluginCatalogEntries: () => [],
}));
vi.mock("../../../plugins/provider-install-catalog.js", () => ({
  resolveProviderInstallCatalogEntries: () => [],
}));
vi.mock("../../../plugins/official-external-plugin-catalog.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../../plugins/official-external-plugin-catalog.js")
  >()),
  listOfficialExternalPluginCatalogEntries: mocks.listOfficialExternalPluginCatalogEntries,
}));
vi.mock("../../../plugins/capability-consent.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../plugins/capability-consent.js")>()),
  prepareManagedPluginArtifactConsentHandler: async () => ({
    onBeforePluginArtifactCommit: async () => {},
    applyAcceptedSurface: (_pluginId: string, record: PluginInstallRecord) => record,
  }),
}));
vi.mock("../../../plugins/provider-policy-surface.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../plugins/provider-policy-surface.js")>()),
  resolveDirectBundledProviderPolicySurface: (
    pluginId: string,
  ): BundledProviderPolicySurface | null =>
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
}));

const testHome = withIsolatedTestHome({ mode: "hermetic" });
const testEnv: NodeJS.ProcessEnv = {
  HOME: testHome.tempHome,
  OPENCLAW_HOME: testHome.tempHome,
  OPENCLAW_STATE_DIR: path.join(testHome.tempHome, ".openclaw"),
  OPENCLAW_COMPATIBILITY_HOST_VERSION: "2026.9.4",
};
afterAll(async () => {
  await closeOpenClawStateDatabaseByPathAsync(resolveOpenClawStateSqlitePath(testEnv));
  testHome.cleanup();
});
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("configured plugin cohort availability", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadInstalledPluginIndexInstallRecords.mockResolvedValue({});
    mocks.loadManifestMetadataSnapshot.mockReturnValue(
      createPluginMetadataSnapshotFixture({ plugins: [] }),
    );
    mocks.listOfficialExternalPluginCatalogEntries.mockReturnValue([]);
    mocks.resolveNpmSpecMetadata.mockImplementation(async ({ spec }: { spec: string }) => {
      const name = spec.slice(0, spec.lastIndexOf("@"));
      return {
        ok: true,
        metadata: { name, version: VERSION, resolvedSpec: `${name}@${VERSION}` },
      };
    });
  });
  beforeAll(async () => {
    await import("./missing-configured-plugin-install.js");
  });

  it("refreshes a stale ClawHub Codex runtime using its declared official catalog source", async () => {
    const actualCatalog = await vi.importActual<
      typeof import("../../../plugins/official-external-plugin-catalog.js")
    >("../../../plugins/official-external-plugin-catalog.js");
    const catalogEntry = expectDefined(
      actualCatalog.getOfficialExternalPluginCatalogEntry("codex"),
      "official Codex catalog entry",
    );
    mocks.listOfficialExternalPluginCatalogEntries.mockReturnValue([catalogEntry]);
    const installDir = tempDirs.make("openclaw-clawhub-runtime-repair-");
    fs.writeFileSync(
      path.join(installDir, "package.json"),
      JSON.stringify({ name: "@openclaw/codex", version: "2026.9.3" }),
    );
    const clawhub = {
      source: "clawhub",
      clawhubUrl: "https://clawhub.ai",
      clawhubPackage: "@openclaw/codex",
      clawhubFamily: "code-plugin",
      clawhubChannel: "official",
    } as const;
    mocks.loadInstalledPluginIndexInstallRecords.mockResolvedValue({
      codex: {
        ...clawhub,
        spec: "clawhub:@openclaw/codex",
        installPath: installDir,
        version: "2026.9.3",
        integrity: "sha256-old-codex",
      },
    });
    mocks.loadManifestMetadataSnapshot.mockReturnValue(
      createPluginMetadataSnapshotFixture({
        plugins: [
          {
            id: "codex",
            origin: "global",
            rootDir: installDir,
            packageVersion: "2026.9.3",
            providers: ["codex"],
          },
        ],
      }),
    );
    mocks.installPluginFromClawHub.mockResolvedValueOnce({
      ok: true,
      pluginId: "codex",
      targetDir: installDir,
      version: "2026.9.4",
      clawhub: { ...clawhub, version: "2026.9.4", integrity: "sha256-new-codex" },
    });
    const { repairMissingConfiguredPluginInstalls } =
      await import("./missing-configured-plugin-install.js");
    const cfg: OpenClawConfigWithLegacyRoster = {
      update: { channel: "stable" },
      agents: {
        defaults: { model: "openai/gpt-5.5", agentRuntime: { id: "codex" } },
      },
    };
    const result = await repairMissingConfiguredPluginInstalls({
      cfg,
      env: testEnv,
    });

    expect(mocks.installPluginFromClawHub).toHaveBeenCalledOnce();
    expect(mocks.installPluginFromClawHub).toHaveBeenCalledWith(
      expect.objectContaining({
        spec: "clawhub:@openclaw/codex@2026.9.4",
        expectedPluginId: "codex",
        baseUrl: "https://clawhub.ai",
        mode: "update",
        expectedIntegrity: undefined,
      }),
    );
    expect(mocks.installPluginFromNpmSpec).not.toHaveBeenCalled();
    expect(result.changes).toEqual([
      'Refreshed stale configured plugin "codex" from clawhub:@openclaw/codex@2026.9.4.',
    ]);
    expect(result.repairedPluginIds).toEqual(["codex"]);
    expect(result.warnings).toEqual([]);
    expect(result.records.codex).toMatchObject({
      ...clawhub,
      spec: "clawhub:@openclaw/codex",
      installPath: installDir,
      version: "2026.9.4",
      integrity: "sha256-new-codex",
    });
    expect(mocks.writePersistedInstalledPluginIndexInstallRecordsWithLease).toHaveBeenCalledWith(
      result.records,
      expect.any(Object),
    );
  });
});

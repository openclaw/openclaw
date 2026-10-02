import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { withIsolatedTestHome } from "../../../../test/test-env.js";
import type { OpenClawConfig } from "../../../config/types.js";
import type { PluginInstallRecord } from "../../../config/types.plugins.js";
import { createPluginMetadataSnapshotFixture } from "../../../plugins/plugin-metadata.test-support.js";
import type { BundledProviderPolicySurface } from "../../../plugins/provider-policy-surface.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../../../state/openclaw-state-db-cache.js";
import { resolveOpenClawStateSqlitePath } from "../../../state/openclaw-state-db.paths.js";
import { VERSION } from "../../../version.js";
import { applyLegacyDoctorMigrations } from "./legacy-config-compat.js";
import { successfulInstall } from "./missing-configured-plugin-install.test-helpers.js";

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
    const result = await repairMissingConfiguredPluginInstalls({
      cfg: {
        update: { channel: "stable" },
        agents: {
          defaults: { model: "openai/gpt-5.5", agentRuntime: { id: "codex" } },
        },
      },
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

  it("upgrades v2026.7.1-beta.3 Codex Supervisor config and installs Codex", async () => {
    const env = { ...testEnv, OPENCLAW_COMPATIBILITY_HOST_VERSION: VERSION };
    // This is the bundled plugin id and config surface shipped by v2026.7.1-beta.3.
    const raw = {
      plugins: {
        allow: ["codex-supervisor"],
        entries: {
          "codex-supervisor": {
            enabled: true,
            config: {
              endpoints: [
                {
                  id: "local",
                  label: "Local Codex",
                  transport: "stdio-proxy",
                  command: "codex",
                  args: ["app-server", "--listen", "stdio://"],
                  cwd: "/tmp/openclaw",
                },
              ],
              allowRawTranscripts: true,
              allowWriteControls: false,
            },
          },
        },
      },
    };
    const migration = applyLegacyDoctorMigrations(raw, { sourceConfigBeforeMigrations: raw });

    expect(migration.next).not.toBeNull();
    const cfg = migration.next as OpenClawConfig;
    expect(cfg.plugins?.allow).toEqual(["codex"]);
    expect(cfg.plugins?.entries?.codex).toEqual({
      enabled: true,
      config: {
        supervision: {
          enabled: true,
          endpoints: [
            {
              id: "local",
              label: "Local Codex",
              transport: "stdio-proxy",
              command: "codex",
              args: ["app-server", "--listen", "stdio://"],
              cwd: "/tmp/openclaw",
            },
          ],
          allowRawTranscripts: true,
          allowWriteControls: false,
        },
      },
    });
    expect(cfg.plugins?.entries).not.toHaveProperty("codex-supervisor");
    expect(migration.changes).toEqual(
      expect.arrayContaining([
        "Moved plugins.entries.codex-supervisor to plugins.entries.codex.config.supervision.",
        "Rewrote plugins.allow codex-supervisor references to codex.",
      ]),
    );

    mocks.installPluginFromNpmSpec.mockResolvedValueOnce(
      successfulInstall({
        pluginId: "codex",
        npmSpec: "@openclaw/codex",
        version: "2026.7.2",
        resolution: {
          integrity: "sha512-codex-supervisor-upgrade",
          resolvedAt: "2026-07-10T00:00:00.000Z",
        },
      }),
    );
    mocks.listOfficialExternalPluginCatalogEntries.mockReturnValue([
      {
        id: "codex",
        openclaw: {
          plugin: { id: "codex", label: "Codex" },
          install: { npmSpec: "@openclaw/codex", defaultChoice: "npm" },
        },
      },
    ]);

    const { repairMissingPluginInstallsForIds } =
      await import("./missing-configured-plugin-install.js");
    const result = await repairMissingPluginInstallsForIds({
      cfg,
      pluginIds: ["codex"],
      env,
      baselineRecords: {},
    });

    expect(mocks.installPluginFromNpmSpec).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        spec: `@openclaw/codex@${VERSION}`,
        expectedPluginId: "codex",
        trustedSourceLinkedOfficialInstall: true,
      }),
    );
    const records = expectDefined(
      mocks.writePersistedInstalledPluginIndexInstallRecordsWithLease.mock.calls[0],
      "persisted plugin records",
    )[0];
    expect(records.codex).toMatchObject({
      source: "npm",
      spec: "@openclaw/codex",
      installPath: "/tmp/openclaw-plugins/codex",
      version: "2026.7.2",
      resolvedName: "@openclaw/codex",
      resolvedSpec: "@openclaw/codex@2026.7.2",
      integrity: "sha512-codex-supervisor-upgrade",
    });
    const databasePath = resolveOpenClawStateSqlitePath(env);
    expect(mocks.writePersistedInstalledPluginIndexInstallRecordsWithLease).toHaveBeenCalledWith(
      records,
      {
        config: cfg,
        env,
        filePath: databasePath,
        lease: expect.objectContaining({
          databasePath,
          assertOwned: expect.any(Function),
          assertOwnedInTransaction: expect.any(Function),
        }),
      },
    );
    expect(result.changes).toEqual([
      `Installed missing configured plugin "codex" from @openclaw/codex@${VERSION}.`,
    ]);
    expect(result.warnings).toEqual([]);
    expect(result.repairedPluginIds).toEqual(["codex"]);
    expect(result.records).toEqual(records);
  });
});

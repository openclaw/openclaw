import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { beforeAll, expect, it, vi } from "vitest";
import type { OpenClawConfigWithLegacyRoster } from "../../../config/legacy.roster.js";
import type { PluginInstallRecord } from "../../../config/types.plugins.js";
import { getOfficialExternalPluginCatalogEntry } from "../../../plugins/official-external-plugin-catalog.js";
import { createPluginMetadataSnapshotFixture } from "../../../plugins/plugin-metadata.test-support.js";
import { setupPluginInstallTestState } from "./missing-configured-plugin-install.test-helpers.js";

const mocks = vi.hoisted(() => ({
  installPluginFromClawHub: vi.fn(),
  installPluginFromNpmSpec: vi.fn(),
  loadInstalledPluginIndexInstallRecords: vi.fn(),
  loadManifestMetadataSnapshot: vi.fn(),
  listOfficialExternalPluginCatalogEntries: vi.fn(),
  writePersistedInstalledPluginIndexInstallRecordsWithLease:
    vi.fn<
      typeof import("../../../plugins/installed-plugin-index-records.js").writePersistedInstalledPluginIndexInstallRecordsWithLease
    >(),
}));

vi.mock("../../../plugins/clawhub.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../plugins/clawhub.js")>()),
  installPluginFromClawHub: mocks.installPluginFromClawHub,
}));
vi.mock("../../../plugins/install.js", () => ({
  installPluginFromNpmSpec: mocks.installPluginFromNpmSpec,
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
    await import("./missing-configured-plugin-install.fixtures.test-support.js")
  ).openaiPolicySurface,
}));

const { testEnv: isolatedEnv, tempDirs } = setupPluginInstallTestState();
const testEnv: NodeJS.ProcessEnv = {
  ...isolatedEnv,
  OPENCLAW_COMPATIBILITY_HOST_VERSION: "2026.9.4",
};

beforeAll(async () => {
  await import("./missing-configured-plugin-install.js");
});

it("refreshes a stale ClawHub Codex runtime using its declared official catalog source", async () => {
  const catalogEntry = expectDefined(
    getOfficialExternalPluginCatalogEntry("codex"),
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

  expect(mocks.installPluginFromClawHub).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      spec: "clawhub:@openclaw/codex@2026.9.4",
      expectedPluginId: "codex",
      baseUrl: "https://clawhub.ai",
      mode: "update",
      expectedIntegrity: undefined,
    }),
  );
  expect(mocks.installPluginFromNpmSpec).not.toHaveBeenCalled();
  expect(result).toMatchObject({
    changes: ['Refreshed stale configured plugin "codex" from clawhub:@openclaw/codex@2026.9.4.'],
    repairedPluginIds: ["codex"],
    warnings: [],
    records: {
      codex: {
        ...clawhub,
        spec: "clawhub:@openclaw/codex",
        installPath: installDir,
        version: "2026.9.4",
        integrity: "sha256-new-codex",
      },
    },
  });
  expect(mocks.writePersistedInstalledPluginIndexInstallRecordsWithLease).toHaveBeenCalledWith(
    result.records,
    expect.any(Object),
  );
});

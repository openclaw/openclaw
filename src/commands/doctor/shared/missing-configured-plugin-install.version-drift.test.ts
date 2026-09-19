import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/types.js";
import type { PluginInstallRecord } from "../../../config/types.plugins.js";
import { parseRegistryNpmSpec } from "../../../infra/npm-registry-spec.js";
import { readPersistedInstalledPluginIndexInstallRecords } from "../../../plugins/installed-plugin-index-records.js";
import { createPluginMetadataSnapshotFixture } from "../../../plugins/plugin-metadata.test-support.js";
import { detectPluginVersionDrift } from "../../../plugins/plugin-version-drift.js";
import { repairMissingConfiguredPluginInstalls } from "./missing-configured-plugin-install.js";
import {
  setupPluginInstallTestState,
  successfulInstall,
} from "./missing-configured-plugin-install.test-helpers.js";

const mocks = vi.hoisted(() => ({
  installPluginFromNpmSpec: vi.fn(),
  resolveNpmSpecMetadata: vi.fn(),
  loadManifestMetadataSnapshot: vi.fn(),
}));

vi.mock("../../../infra/install-source-utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../infra/install-source-utils.js")>()),
  resolveNpmSpecMetadata: mocks.resolveNpmSpecMetadata,
}));
vi.mock("../../../plugins/install.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../plugins/install.js")>()),
  installPluginFromNpmSpec: mocks.installPluginFromNpmSpec,
}));
vi.mock("../../../plugins/manifest-contract-eligibility.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../plugins/manifest-contract-eligibility.js")>()),
  loadManifestMetadataSnapshot: mocks.loadManifestMetadataSnapshot,
}));
vi.mock("../../../plugins/manifest-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../plugins/manifest-registry.js")>()),
  loadPluginManifestRegistryCore: () => ({ plugins: [], diagnostics: [] }),
}));
vi.mock("../../../plugins/bundled-sources.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../plugins/bundled-sources.js")>()),
  resolveBundledPluginSources: () => new Map(),
}));
vi.mock("../../../plugins/update-capability-consent.js", () => ({
  // The lower installer is stubbed; its staged artifact consent has separate owner tests.
  preparePluginUpdateCapabilityConsent: () => ({
    onBeforePluginArtifactCommit: async () => {},
    acceptInstallRecord: <T extends PluginInstallRecord>(record: T): T => record,
  }),
}));

const { testEnv, tempDirs } = setupPluginInstallTestState();
const oldVersion = "2026.9.3";
const coreVersion = "2026.9.5";

function createDriftedInstalls({
  hostVersion = coreVersion,
  packages = [
    ["discord", "@openclaw/discord"],
    ["exa", "@openclaw/exa-plugin"],
    ["community", "@example/community"],
  ],
}: { hostVersion?: string; packages?: [string, string][] } = {}) {
  const stateDir = tempDirs.make("openclaw-doctor-plugin-version-drift-");
  const env = {
    ...testEnv,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_COMPATIBILITY_HOST_VERSION: hostVersion,
  };
  const records: Record<string, PluginInstallRecord> = {};
  for (const [pluginId, packageName] of packages) {
    const installPath = path.join(stateDir, "extensions", pluginId);
    fs.mkdirSync(installPath, { recursive: true });
    fs.writeFileSync(
      path.join(installPath, "package.json"),
      JSON.stringify({
        name: packageName,
        version: oldVersion,
        openclaw: { extensions: ["./index.js"] },
      }),
    );
    fs.writeFileSync(path.join(installPath, "index.js"), "export default function register() {}\n");
    records[pluginId] = {
      source: "npm",
      spec: `${packageName}@${oldVersion}`,
      resolvedName: packageName,
      resolvedSpec: `${packageName}@${oldVersion}`,
      version: oldVersion,
      resolvedVersion: oldVersion,
      installPath,
    };
  }
  const cfg: OpenClawConfig = {
    update: { channel: hostVersion.includes("-beta.") ? "beta" : "stable" },
    plugins: {
      allow: Object.keys(records),
      entries: Object.fromEntries(Object.keys(records).map((id) => [id, { enabled: true }])),
    },
  };
  mocks.loadManifestMetadataSnapshot.mockReturnValue(
    createPluginMetadataSnapshotFixture({
      plugins: Object.entries(records).map(([id, record]) => ({
        id,
        origin: "global",
        rootDir: record.installPath,
        packageName: record.resolvedName,
        packageVersion: oldVersion,
      })),
    }),
  );
  mocks.installPluginFromNpmSpec.mockImplementation(
    async ({ spec, expectedPluginId }: { spec: string; expectedPluginId: string }) => {
      const parsed = parseRegistryNpmSpec(spec);
      if (!parsed || parsed.selectorKind !== "exact-version") {
        throw new Error(`Expected an exact plugin target, received ${spec}`);
      }
      return successfulInstall({
        pluginId: expectedPluginId,
        npmSpec: parsed.name,
        version: parsed.selector,
        targetDir: expectDefined(records[expectedPluginId], "installed plugin fixture").installPath,
      });
    },
  );
  return { cfg, env, records };
}

function driftIds(
  cfg: OpenClawConfig,
  records: Record<string, PluginInstallRecord>,
  hostVersion = coreVersion,
) {
  return detectPluginVersionDrift({
    config: cfg,
    gatewayVersion: hostVersion,
    installRecords: records,
  }).drifts.map(({ pluginId }) => pluginId);
}

describe("Doctor official plugin version repair", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveNpmSpecMetadata.mockImplementation(async ({ spec }: { spec: string }) => {
      const parsed = parseRegistryNpmSpec(spec);
      if (!parsed) {
        throw new Error(`Invalid package spec: ${spec}`);
      }
      const version = parsed.selectorKind === "exact-version" ? parsed.selector : "2026.9.6";
      return {
        ok: true,
        metadata: { name: parsed.name, version, resolvedSpec: `${parsed.name}@${version}` },
      };
    });
  });

  it.each([coreVersion, "2026.9.5-beta.2"])(
    "converges official installs to core %s and leaves third-party installs untouched",
    async (hostVersion) => {
      const { cfg, env, records } = createDriftedInstalls({ hostVersion });
      expect(driftIds(cfg, records)).toEqual(["discord", "exa"]);

      const result = await repairMissingConfiguredPluginInstalls({
        cfg,
        env,
        repairVersionDrift: true,
        baselineRecords: records,
      });

      expect(result.repairedPluginIds).toEqual(["discord", "exa"]);
      expect(result.warnings).toEqual([]);
      expect(result.records.discord).toMatchObject({
        version: hostVersion,
        resolvedVersion: hostVersion,
      });
      expect(result.records.exa).toMatchObject({
        version: hostVersion,
        resolvedVersion: hostVersion,
      });
      expect(result.records.community).toEqual(records.community);
      expect(mocks.installPluginFromNpmSpec.mock.calls.map(([request]) => request.spec)).toEqual([
        `@openclaw/discord@${hostVersion}`,
        `@openclaw/exa-plugin@${hostVersion}`,
      ]);
      const persisted = expectDefined(
        readPersistedInstalledPluginIndexInstallRecords({ env }),
        "persisted plugin install records",
      );
      expect(persisted).toEqual(result.records);
      expect(driftIds(cfg, persisted, hostVersion)).toEqual([]);
    },
  );

  it("warns with the unavailable target reason, retains its install, and repairs the other official plugin", async () => {
    const { cfg, env, records } = createDriftedInstalls();
    const resolveMetadata = expectDefined(
      mocks.resolveNpmSpecMetadata.getMockImplementation(),
      "metadata resolver",
    );
    mocks.resolveNpmSpecMetadata.mockImplementation((request: { spec: string }) =>
      request.spec.startsWith("@openclaw/discord")
        ? Promise.resolve({
            ok: false,
            category: "metadata-env",
            error: "ECONNREFUSED registry unreachable",
          })
        : resolveMetadata(request),
    );
    const onWarning = vi.fn();

    const result = await repairMissingConfiguredPluginInstalls({
      cfg,
      env,
      repairVersionDrift: true,
      baselineRecords: records,
      onWarning,
    });

    expect(result.repairedPluginIds).toEqual(["exa"]);
    expect(result.records.discord).toEqual(records.discord);
    expect(result.records.community).toEqual(records.community);
    expect(result.warnings.join("\n")).toContain("ECONNREFUSED registry unreachable");
    expect(result.warnings.join("\n")).toContain("@openclaw/discord@2026.9.5");
    expect(onWarning).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("ECONNREFUSED") }),
    );
    expect(mocks.installPluginFromNpmSpec.mock.calls.map(([request]) => request.spec)).toEqual([
      "@openclaw/exa-plugin@2026.9.5",
    ]);
    const persisted = expectDefined(
      readPersistedInstalledPluginIndexInstallRecords({ env }),
      "persisted plugin install records",
    );
    expect(persisted).toEqual(result.records);
    expect(driftIds(cfg, persisted)).toEqual(["discord"]);
  });

  it("leaves healthy version drift alone unless the repair caller opts in", async () => {
    const { cfg, env, records } = createDriftedInstalls();

    const result = await repairMissingConfiguredPluginInstalls({
      cfg,
      env,
      baselineRecords: records,
    });

    expect(result.records).toEqual(records);
    expect(result.changes).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(mocks.resolveNpmSpecMetadata).not.toHaveBeenCalled();
    expect(mocks.installPluginFromNpmSpec).not.toHaveBeenCalled();
    expect(readPersistedInstalledPluginIndexInstallRecords({ env })).toEqual(records);
  });

  it("defers version repair while the updater owns an unfinished core package swap", async () => {
    const { cfg, env, records } = createDriftedInstalls();

    const result = await repairMissingConfiguredPluginInstalls({
      cfg,
      repairVersionDrift: true,
      env: {
        ...env,
        OPENCLAW_UPDATE_IN_PROGRESS: "1",
        OPENCLAW_UPDATE_DEFER_CONFIGURED_PLUGIN_INSTALL_REPAIR: "1",
      },
      baselineRecords: records,
    });

    expect(result.records).toEqual(records);
    expect(result.repairedPluginIds ?? []).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(mocks.resolveNpmSpecMetadata).not.toHaveBeenCalled();
    expect(mocks.installPluginFromNpmSpec).not.toHaveBeenCalled();
    expect(readPersistedInstalledPluginIndexInstallRecords({ env })).toEqual(records);
  });

  it("reports the exact manual migration command for a legacy official plugin id", async () => {
    const { cfg, env, records } = createDriftedInstalls({
      packages: [["fish-audio", "@openclaw/fish-audio-speech"]],
    });

    const result = await repairMissingConfiguredPluginInstalls({
      cfg,
      env,
      repairVersionDrift: true,
      baselineRecords: records,
    });

    expect(result.records).toEqual(records);
    expect(result.warnings).toEqual([
      expect.stringContaining("openclaw plugins update @openclaw/fish-audio-speech@2026.9.5"),
    ]);
    expect(mocks.installPluginFromNpmSpec).not.toHaveBeenCalled();
    expect(readPersistedInstalledPluginIndexInstallRecords({ env })).toEqual(records);
  });
});

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
import { convergePluginReleaseCohort } from "../../../plugins/update-cohort.js";
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
  installedVersion = oldVersion,
  dependencies,
  packages = [
    ["discord", "@openclaw/discord"],
    ["exa", "@openclaw/exa-plugin"],
    ["community", "@example/community"],
  ],
}: {
  hostVersion?: string;
  installedVersion?: string;
  dependencies?: Record<string, string>;
  packages?: [string, string][];
} = {}) {
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
        version: installedVersion,
        dependencies,
        openclaw: { extensions: ["./index.js"] },
      }),
    );
    fs.writeFileSync(path.join(installPath, "index.js"), "export default function register() {}\n");
    fs.writeFileSync(
      path.join(installPath, "openclaw.plugin.json"),
      JSON.stringify({ id: pluginId, configSchema: { type: "object" } }),
    );
    records[pluginId] = {
      source: "npm",
      spec: `${packageName}@${installedVersion}`,
      resolvedName: packageName,
      resolvedSpec: `${packageName}@${installedVersion}`,
      version: installedVersion,
      resolvedVersion: installedVersion,
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
        packageVersion: installedVersion,
        packageDependencies: dependencies,
      })),
    }),
  );
  mocks.installPluginFromNpmSpec.mockImplementation(
    async ({ spec, expectedPluginId }: { spec: string; expectedPluginId: string }) => {
      const parsed = parseRegistryNpmSpec(spec);
      if (!parsed) {
        throw new Error(`Invalid plugin target: ${spec}`);
      }
      const version = parsed.selectorKind === "exact-version" ? parsed.selector : "2026.9.6";
      const targetDir = expectDefined(
        records[expectedPluginId],
        "installed plugin fixture",
      ).installPath;
      const manifestPath = path.join(expectDefined(targetDir, "fixture path"), "package.json");
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      fs.writeFileSync(manifestPath, JSON.stringify({ ...manifest, version }));
      return successfulInstall({
        pluginId: expectedPluginId,
        npmSpec: parsed.name,
        version,
        targetDir,
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

  describe.each(["Doctor repair", "core-update convergence"])("%s selector policy", (caller) => {
    it.each([
      ["next", oldVersion, coreVersion, "2026.9.6"],
      ["beta", oldVersion, coreVersion, "2026.9.6"],
      ["2026.9.6", "2026.9.6", coreVersion, "2026.9.6"],
      ["2026.9.5-1", oldVersion, "2026.9.5-2", "2026.9.5-1"],
    ])(
      "honors @%s over the cohort with installed %s and core %s",
      async (selector, installedVersion, hostVersion, expectedVersion) => {
        const { cfg, env, records } = createDriftedInstalls({
          hostVersion,
          installedVersion,
          packages: [["discord", "@openclaw/discord"]],
        });
        const spec = `@openclaw/discord@${selector}`;
        const record = expectDefined(records.discord, "discord install");
        record.spec = spec;
        const updatedRecords =
          caller === "Doctor repair"
            ? (
                await repairMissingConfiguredPluginInstalls({
                  cfg,
                  env,
                  repairVersionDrift: true,
                  baselineRecords: records,
                })
              ).records
            : (
                await convergePluginReleaseCohort({
                  config: { ...cfg, plugins: { ...cfg.plugins, installs: records } },
                  env,
                  channel: "stable",
                  coreVersion: hostVersion,
                  timeoutMs: 60_000,
                })
              ).config.plugins?.installs;

        expect(mocks.resolveNpmSpecMetadata.mock.calls[0]?.[0].spec).toBe(spec);
        expect(updatedRecords?.discord).toMatchObject({
          spec,
          version: expectedVersion,
          resolvedVersion: expectedVersion,
          resolvedSpec: `@openclaw/discord@${expectedVersion}`,
        });
        expect(
          JSON.parse(
            fs.readFileSync(
              path.join(expectDefined(record.installPath, "fixture path"), "package.json"),
              "utf8",
            ),
          ).version,
        ).toBe(expectedVersion);
        if (caller === "Doctor repair") {
          expect(readPersistedInstalledPluginIndexInstallRecords({ env })).toEqual(updatedRecords);
        }
      },
    );
  });

  it("reinstalls a newer official pin with missing dependencies during drift repair", async () => {
    const { cfg, env, records } = createDriftedInstalls({
      installedVersion: "2026.9.6",
      dependencies: { "required-runtime": "1.0.0" },
      packages: [["discord", "@openclaw/discord"]],
    });

    const result = await repairMissingConfiguredPluginInstalls({
      cfg,
      env,
      repairVersionDrift: true,
      baselineRecords: records,
    });

    expect(mocks.installPluginFromNpmSpec.mock.calls.map(([request]) => request.spec)).toEqual([
      "@openclaw/discord@2026.9.6",
    ]);
    expect(result.records.discord).toMatchObject({
      spec: "@openclaw/discord@2026.9.6",
      version: "2026.9.6",
      resolvedVersion: "2026.9.6",
      resolvedSpec: "@openclaw/discord@2026.9.6",
    });
    expect(result.changes).toEqual([
      'Repaired missing dependencies for installed plugin "discord".',
      "If the Gateway is not restarted by Doctor, run openclaw gateway restart to load the updated plugins.",
    ]);
    expect(result.warnings).toEqual([]);
    expect(readPersistedInstalledPluginIndexInstallRecords({ env })).toEqual(result.records);
  });

  it.each([coreVersion, "2026.9.5-beta.2"])(
    "keeps aligned floating official installs unchanged at core %s when the registry is ahead",
    async (hostVersion) => {
      const { cfg, env, records } = createDriftedInstalls({
        hostVersion,
        installedVersion: hostVersion,
        packages: [
          ["discord", "@openclaw/discord"],
          ["exa", "@openclaw/exa-plugin"],
        ],
      });
      expectDefined(records.discord, "discord install").spec = "@openclaw/discord";
      expectDefined(records.exa, "exa install").spec = "@openclaw/exa-plugin@latest";
      const config = { ...cfg, plugins: { ...cfg.plugins, installs: records } };

      const result = await convergePluginReleaseCohort({
        config,
        env,
        channel: hostVersion.includes("-beta.") ? "beta" : "stable",
        coreVersion: hostVersion,
        timeoutMs: 60_000,
      });

      expect(mocks.resolveNpmSpecMetadata.mock.calls.map(([request]) => request.spec)).toEqual([
        `@openclaw/discord@${hostVersion}`,
        `@openclaw/exa-plugin@${hostVersion}`,
      ]);
      expect(mocks.installPluginFromNpmSpec).not.toHaveBeenCalled();
      expect(result.changed).toBe(false);
      expect(result.npmChanged).toBe(false);
      expect(result.config).toEqual(config);
      expect(result.updateOutcomes).toMatchObject([
        { pluginId: "discord", status: "unchanged", currentVersion: hostVersion },
        { pluginId: "exa", status: "unchanged", currentVersion: hostVersion },
      ]);
    },
  );

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

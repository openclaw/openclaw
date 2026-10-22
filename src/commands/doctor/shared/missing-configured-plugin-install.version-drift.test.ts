import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/types.js";
import type { PluginInstallRecord } from "../../../config/types.plugins.js";
import { parseRegistryNpmSpec } from "../../../infra/npm-registry-spec.js";
import { readPersistedInstalledPluginIndexInstallRecordsAsync as readIndexRecords } from "../../../plugins/installed-plugin-index-records.js";
import { createPluginMetadataSnapshotFixture } from "../../../plugins/plugin-metadata.test-support.js";
import { detectPluginVersionDrift } from "../../../plugins/plugin-version-drift.js";
import { invokePluginArtifactInstallMock } from "../../../plugins/test-helpers/install-fixtures.js";
import { writePluginJson } from "./missing-configured-plugin-install.fixtures.test-support.js";
import { repairMissingConfiguredPluginInstalls as repairInstalls } from "./missing-configured-plugin-install.js";
import {
  setupPluginInstallTestState,
  successfulInstall,
} from "./missing-configured-plugin-install.test-helpers.js";
import { runPostCorePluginConvergence } from "./post-core-plugin-convergence.js";

const mocks = vi.hoisted(() => ({
  installPluginFromNpmSpec: vi.fn(),
  resolveNpmSpecMetadata: vi.fn(),
  loadManifestMetadataSnapshot: vi.fn(),
}));

vi.mock("../../../infra/install-source-utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../infra/install-source-utils.js")>()),
  resolveNpmSpecMetadata: mocks.resolveNpmSpecMetadata,
}));
vi.mock("../../../plugins/install.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../plugins/install.js")>();
  return {
    ...actual,
    installPluginFromNpmSpec: (params: Parameters<typeof actual.installPluginFromNpmSpec>[0]) =>
      invokePluginArtifactInstallMock<Awaited<ReturnType<typeof actual.installPluginFromNpmSpec>>>(
        mocks.installPluginFromNpmSpec,
        params,
        { manifest: { providers: [], channels: [], channelConfigs: {}, providerAuthChoices: [] } },
      ),
  };
});
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
const packageRuntime = { extensions: ["./index.js"] };
const defaultPackages: Record<string, string> = {
  discord: "@openclaw/discord",
  exa: "@openclaw/exa-plugin",
  community: "@example/community",
};
const registryUnavailable = {
  ok: false,
  category: "metadata-env",
  error: "ECONNREFUSED registry unreachable",
};

function writePackage(root: string, name: string, version: string) {
  writePluginJson(root, "package.json", { name, version, openclaw: packageRuntime });
}

function npmTarget(spec: string) {
  const parsed = expectDefined(parseRegistryNpmSpec(spec), "npm fixture target");
  const version =
    parsed.selectorKind === "exact-version"
      ? expectDefined(parsed.selector, "exact npm fixture version")
      : "2026.9.6";
  return { name: parsed.name, version, resolvedSpec: `${parsed.name}@${version}` };
}

function createDriftedInstalls({
  hostVersion = coreVersion,
  installedVersion = oldVersion,
  packages = defaultPackages,
} = {}) {
  const stateDir = tempDirs.make("openclaw-doctor-plugin-version-drift-");
  const env = {
    ...testEnv,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_COMPATIBILITY_HOST_VERSION: hostVersion,
  };
  const records: Record<string, PluginInstallRecord> = {};
  for (const [id, packageName] of Object.entries(packages)) {
    const installPath = path.join(stateDir, "extensions", id);
    fs.mkdirSync(installPath, { recursive: true });
    writePackage(installPath, packageName, installedVersion);
    fs.writeFileSync(path.join(installPath, "index.js"), "export default function register() {}\n");
    writePluginJson(installPath, "openclaw.plugin.json", { id, configSchema: { type: "object" } });
    records[id] = {
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
      })),
    }),
  );
  mocks.installPluginFromNpmSpec.mockImplementation(
    async ({ spec, expectedPluginId }: { spec: string; expectedPluginId: string }) => {
      const { name, version } = npmTarget(spec);
      const targetDir = expectDefined(
        expectDefined(records[expectedPluginId], "installed plugin fixture").installPath,
        "fixture path",
      );
      writePackage(targetDir, name, version);
      return successfulInstall({ pluginId: expectedPluginId, npmSpec: name, version, targetDir });
    },
  );
  const repair = async (options: Partial<Parameters<typeof repairInstalls>[0]> = {}) => {
    const result = await repairInstalls({
      cfg,
      env,
      baselineRecords: records,
      repairVersionDrift: true,
      ...options,
    });
    expect(await readIndexRecords({ env })).toEqual(result.records);
    return result;
  };
  const driftIds = (installRecords = records, gatewayVersion = coreVersion) =>
    detectPluginVersionDrift({ config: cfg, gatewayVersion, installRecords }).drifts.map(
      ({ pluginId }) => pluginId,
    );
  return { cfg, env, records, repair, driftIds };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveNpmSpecMetadata.mockImplementation(async ({ spec }: { spec: string }) => ({
    ok: true,
    metadata: npmTarget(spec),
  }));
});

it.each([true, false])(
  "converges the app-owned post-core cohort or reports pending repair (available=%s)",
  async (available) => {
    const { cfg, env, records } = createDriftedInstalls({
      packages: { discord: "@openclaw/discord" },
    });
    if (!available) {
      mocks.resolveNpmSpecMetadata.mockResolvedValue(registryUnavailable);
    }
    const result = await runPostCorePluginConvergence({
      cfg,
      env: {
        ...env,
        OPENCLAW_UPDATE_IN_PROGRESS: "1",
        OPENCLAW_UPDATE_POST_CORE_CONVERGENCE: "1",
        OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE: "1",
        OPENCLAW_SERVICE_REPAIR_POLICY: "external",
        OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_ACTIVATION: "0",
      },
      baselineInstallRecords: records,
      compatibilityHostVersion: coreVersion,
    });

    if (available) {
      expect(result.installRecords.discord?.version).toBe(coreVersion);
      expect(result.warnings).toEqual([]);
    } else {
      expect(result.installRecords.discord).toEqual(records.discord);
      expect(result.errored).toBe(false);
      expect(result.warnings).toContainEqual(
        expect.objectContaining({
          pluginId: "discord",
          message: expect.stringContaining(oldVersion),
          guidance: ["Run `openclaw update repair` to retry plugin repair."],
        }),
      );
    }
  },
);

it.each([
  ["codex", "@openclaw/codex", coreVersion, oldVersion, coreVersion, "stable", true],
  ["codex", "@openclaw/codex@next", coreVersion, "2026.9.6", "2026.9.6", "extended-stable", true],
  ["codex", "@openclaw/codex@latest", "2026.9.5-1", "2026.9.5-2", coreVersion, "stable", true],
  ["discord", "@openclaw/discord@2026.9.6", coreVersion, "2026.9.6", "2026.9.6", "stable", false],
] as const)(
  "preserves %s selector %s at host %s (installed=%s, target=%s, channel=%s, incomplete=%s)",
  async (pluginId, spec, hostVersion, installedVersion, expectedVersion, channel, incomplete) => {
    const packageName = `@openclaw/${pluginId}`;
    const { cfg, records, repair } = createDriftedInstalls({
      hostVersion,
      installedVersion,
      packages: { [pluginId]: packageName },
    });
    cfg.update = { channel };
    const record = expectDefined(records[pluginId], "plugin install");
    record.spec = spec;
    if (incomplete) {
      fs.unlinkSync(path.join(expectDefined(record.installPath, "fixture path"), "package.json"));
    }
    const result = await repair({
      onCapabilityConsent: incomplete ? async ({ reviewToken }) => ({ reviewToken }) : undefined,
    });
    expect(result.records[pluginId]).toMatchObject({
      spec,
      version: expectedVersion,
      resolvedVersion: expectedVersion,
      resolvedSpec: `${packageName}@${expectedVersion}`,
    });
    if (incomplete) {
      expect(result).toMatchObject({ repairedPluginIds: [pluginId], warnings: [] });
    } else {
      expect(mocks.resolveNpmSpecMetadata.mock.calls[0]?.[0].spec).toBe(spec);
    }
  },
);

it.each([false, true])(
  "converges the official cohort (registry unavailable=%s)",
  async (unavailable) => {
    const hostVersion = unavailable ? coreVersion : "2026.9.5-beta.2";
    const { records, repair, driftIds } = createDriftedInstalls({ hostVersion });
    if (unavailable) {
      mocks.resolveNpmSpecMetadata.mockImplementation(async ({ spec }: { spec: string }) =>
        spec.startsWith("@openclaw/discord")
          ? registryUnavailable
          : { ok: true, metadata: npmTarget(spec) },
      );
    } else {
      expect(driftIds()).toEqual(["discord", "exa"]);
    }
    const onWarning = vi.fn();
    const result = await repair({ onWarning });
    const expectedVersion = { version: hostVersion, resolvedVersion: hostVersion };
    expect(result.repairedPluginIds).toEqual(unavailable ? ["exa"] : ["discord", "exa"]);
    expect(result.records.community).toEqual(records.community);
    expect(result.records.exa).toMatchObject(expectedVersion);
    if (unavailable) {
      expect(result.records.discord).toEqual(records.discord);
      expect(result.warnings.join("\n")).toContain("ECONNREFUSED registry unreachable");
      expect(result.warnings.join("\n")).toContain("@openclaw/discord@2026.9.5");
      expect(onWarning).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringContaining("ECONNREFUSED") }),
      );
    } else {
      expect(result.records.discord).toMatchObject(expectedVersion);
      expect(result.warnings).toEqual([]);
    }
    expect(mocks.installPluginFromNpmSpec.mock.calls.map(([request]) => request.spec)).toEqual([
      ...(unavailable ? [] : [`@openclaw/discord@${hostVersion}`]),
      `@openclaw/exa-plugin@${hostVersion}`,
    ]);
    expect(driftIds(result.records, hostVersion)).toEqual(unavailable ? ["discord"] : []);
  },
);

it.each(["core swap", "legacy id"])("retains installs for %s", async (reason) => {
  const { env, records, repair } = createDriftedInstalls(
    reason === "legacy id" ? { packages: { "fish-audio": "@openclaw/fish-audio-speech" } } : {},
  );

  if (reason === "core swap") {
    Object.assign(env, {
      OPENCLAW_UPDATE_IN_PROGRESS: "1",
      OPENCLAW_UPDATE_DEFER_CONFIGURED_PLUGIN_INSTALL_REPAIR: "1",
    });
  }
  const result = await repair();

  expect(result.records).toEqual(records);
  expect(result.warnings).toEqual(
    reason === "legacy id"
      ? [expect.stringContaining("openclaw plugins update @openclaw/fish-audio-speech@2026.9.5")]
      : [],
  );
  expect(mocks.installPluginFromNpmSpec).not.toHaveBeenCalled();
  if (reason === "core swap") {
    expect(mocks.resolveNpmSpecMetadata).not.toHaveBeenCalled();
    expect(result.repairedPluginIds ?? []).toEqual([]);
  }
});

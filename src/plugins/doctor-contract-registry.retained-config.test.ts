import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { defineRetiredPluginStateMigration } from "./doctor-retired-state.js";
import { createPluginManifestRecordFixture } from "./plugin-metadata.test-support.js";
import {
  getRegistryJitiMocks,
  resetRegistryJitiMocks,
} from "./test-helpers/registry-jiti-mocks.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const mocks = getRegistryJitiMocks();
const loadRetained = vi.hoisted(() => vi.fn());
// mock-isolation: Supply retained artifacts without loading installed plugin code.
vi.mock("./public-surface-loader.js", () => ({
  loadBundledPluginPublicArtifactModuleFromCandidatesSync: loadRetained,
}));
let doctor: typeof import("./doctor-contract-registry.js");
let migrationResources: typeof import("./doctor-migration-resources.js");
const channelConfig = () => ({
  channels: { discord: { dm: { enabled: true, policy: "allowlist" } } },
});

beforeAll(async () => {
  vi.resetModules();
  doctor = await import("./doctor-contract-registry.js");
  migrationResources = await import("./doctor-migration-resources.js");
});
beforeEach(() => {
  resetRegistryJitiMocks();
  mocks.loadPluginManifestRegistry.mockReturnValue({ plugins: [], diagnostics: [] });
  loadRetained.mockReset().mockReturnValue(null);
});

it("repairs retained channel config before installation without selecting state owners", () => {
  const rule = { path: ["channels", "discord", "dm", "policy"], message: "retired DM policy" };
  const config = { ...channelConfig(), plugins: { allow: [] } };
  loadRetained.mockReturnValue({
    legacyConfigRules: [rule],
    normalizeCompatibilityConfig: ({ cfg }: { cfg: typeof config }) => ({
      config: { ...cfg, channels: { discord: { dmPolicy: cfg.channels.discord.dm.policy } } },
      changes: ["moved DM policy"],
    }),
    resolveSessionStoreAgentIds: () => {
      throw new Error("must not select retained state owners");
    },
  });

  expect(doctor.listPluginDoctorLegacyConfigRules({ config, env: {} })).toEqual([rule]);
  expect(doctor.applyPluginDoctorCompatibilityMigrations(config, { env: {} })).toEqual({
    config: { channels: { discord: { dmPolicy: "allowlist" } }, plugins: { allow: [] } },
    changes: ["moved DM policy"],
  });
  expect(config.channels.discord.dm.policy).toBe("allowlist");
  expect(loadRetained).toHaveBeenCalledWith({
    dirName: "discord",
    artifactCandidates: ["config-doctor-api.js"],
    env: {},
  });
  loadRetained.mockClear();
  expect([
    doctor.listPluginDoctorSessionStoreAgentIds({ config, env: {} }),
    doctor.listPluginDoctorSessionRouteStateOwners({ config, env: {} }),
  ]).toEqual([[], []]);
  expect(loadRetained).not.toHaveBeenCalled();
});

it.each([false, true])("keeps installed owner (configRepair=%s)", (configRepair) => {
  mocks.loadPluginManifestRegistry.mockReturnValue({
    plugins: [
      {
        id: "installed-owner",
        channels: ["discord"],
        providers: [],
        rootDir: tempDirs.make("openclaw-retained-config-doctor-"),
        doctorContract: { configRepair },
      },
    ],
    diagnostics: [],
  });
  const config = channelConfig();
  expect(doctor.listPluginDoctorLegacyConfigRules({ config, env: {} })).toEqual([]);
  const result = doctor.applyPluginDoctorCompatibilityMigrations(config, { env: {} });
  expect(result).toEqual({ config, changes: [] });
  expect(loadRetained).not.toHaveBeenCalled();
});

it("does not probe retained modules outside the selected known channel scope", () => {
  const scopes = [
    { config: { channels: { discord: {}, "../outside": {}, defaults: {} } }, pluginIds: ["slack"] },
    { config: { channels: { "../outside": {} } } },
  ];
  expect(
    scopes.map((scope) => doctor.listPluginDoctorLegacyConfigRules({ ...scope, env: {} })),
  ).toEqual([[], []]);
  expect(loadRetained).not.toHaveBeenCalled();
});
it.each([
  { name: "selected official owner", refuses: true },
  { name: "external shadow", trusted: false },
  { name: "different package", packageName: "@other/demo" },
  { name: "different migration", declared: false },
  { name: "disabled owner", enabled: false },
])(
  "checks only the matching $name",
  async ({
    trusted = true,
    declared = true,
    enabled = true,
    packageName = "@openclaw/demo",
    refuses = false,
  }) => {
    const stateDir = tempDirs.make("openclaw-retained-config-doctor-");
    const source = path.join(stateDir, "custom-history.jsonl");
    fs.writeFileSync(source, "opaque historical bytes\n");
    const migration = defineRetiredPluginStateMigration({
      id: "retired-log",
      label: "Call log",
      intermediateVersion: "2026.9.7",
      findSources: () => [source],
    });
    loadRetained.mockReturnValue({
      packageName: "@openclaw/demo",
      stateMigrations: [migration],
    });
    const owner = createPluginManifestRecordFixture({
      id: "demo",
      origin: "global",
      rootDir: stateDir,
      packageName,
      trustedOfficialInstall: trusted,
      doctorContract: { stateMigrations: [{ id: declared ? "retired-log" : "other" }] },
    });
    const params = {
      candidateRoot: stateDir,
      config: { plugins: { entries: { demo: { enabled } } } },
      env: { HOME: stateDir, OPENCLAW_STATE_DIR: stateDir, OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" },
      stateDir,
      manifestRegistry: { plugins: [owner], diagnostics: [] },
    };
    const records = doctor
      .resolvePluginDoctorStateMigrationRecords({ ...params, artifactPreservingReadOnly: true })
      .filter(doctor.isTrustedForDurableStores);
    const check = migrationResources.assertPluginStateRetention(records, params);
    if (refuses) {
      await expect(check).rejects.toThrow("Install OpenClaw 2026.9.7");
    } else {
      await expect(check).resolves.toBeUndefined();
    }
    expect(fs.readFileSync(source, "utf8")).toBe("opaque historical bytes\n");
    expect(fs.readdirSync(stateDir)).toEqual(["custom-history.jsonl"]);
  },
);

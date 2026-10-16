import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import { withMockedPlatform } from "../test-utils/vitest-spies.js";
import { resolvePluginDoctorContractArtifact } from "./doctor-contract-artifact.js";
import type * as DoctorContractRegistry from "./doctor-contract-registry.js";
import { useDoctorContractRegistryHarness } from "./doctor-contract-registry.test-harness.js";
import { createPluginCache, withPluginCache } from "./plugin-cache.js";
import { createPluginManifestRecordFixture } from "./plugin-metadata.test-support.js";
const retainedConfigDoctorMock = vi.hoisted(() => vi.fn());
// mock-isolation: Script retained artifacts without loading real bundled plugin modules.
vi.mock("./public-surface-loader.js", () => ({
  loadBundledPluginPublicArtifactModuleFromCandidatesSync: retainedConfigDoctorMock,
}));
const harness = useDoctorContractRegistryHarness({
  reset: () => {
    mockDoctorPlugins();
    retainedConfigDoctorMock.mockReset().mockReturnValue(null);
  },
});
const { mocks, warn: doctorContractWarnMock, makeTempDir } = harness;

let doctor: typeof DoctorContractRegistry;

function registry(...plugins: Parameters<typeof createPluginManifestRecordFixture>[0][]) {
  return {
    plugins: plugins.map(createPluginManifestRecordFixture),
    diagnostics: [],
  };
}

function mockDoctorPlugins(...plugins: Parameters<typeof createPluginManifestRecordFixture>[0][]) {
  mocks.loadPluginManifestRegistry.mockReturnValue(registry(...plugins));
}

function writeContract(source = "export {};\n", name = "doctor-contract-api.ts") {
  const root = makeTempDir();
  fs.writeFileSync(path.join(root, name), source, "utf-8");
  return root;
}

function mockContract(
  exports: Record<string, unknown>,
  plugin: Parameters<typeof createPluginManifestRecordFixture>[0],
) {
  const rootDir = writeContract();
  mocks.createJiti.mockImplementation(() => () => exports);
  mockDoctorPlugins({ rootDir, ...plugin });
  return rootDir;
}

const providerRenames = [{ from: "old", to: "new", baseUrl: "https://models.example" }];

function mockExternalShadow(enabledByDefault = false) {
  const bundled = registry({
    id: "matrix",
    rootDir: makeTempDir(),
    origin: "bundled",
    channels: [],
    providers: [],
    doctorContract: { stateMigrations: [{ id: "matrix-inbound-dedupe-to-claimable-dedupe" }] },
  });
  mocks.loadPluginManifestRegistry.mockReturnValueOnce(bundled).mockReturnValueOnce(
    registry({
      id: "matrix",
      rootDir: makeTempDir(),
      origin: "global",
      doctorContract: bundled.plugins[0]?.doctorContract,
      ...(enabledByDefault ? { enabledByDefault } : {}),
    }),
  );
}

describe("doctor-contract-registry module loader", () => {
  beforeAll(() => {
    doctor = harness.registry;
  });

  it("preserves source artifact precedence across root and dist candidates", () => {
    const pluginRoot = makeTempDir();
    const distRoot = path.join(pluginRoot, "dist");
    fs.mkdirSync(distRoot);
    const candidates = [
      "doctor-contract-api.ts",
      "dist/doctor-contract-api.ts",
      "contract-api.cjs",
    ].map((relativePath) => path.join(pluginRoot, relativePath));
    for (const filePath of candidates) {
      fs.writeFileSync(filePath, "export {};\n", "utf-8");
    }

    const originalOwner = createPluginCache();
    const resolvePath = () =>
      resolvePluginDoctorContractArtifact({
        rootDir: pluginRoot,
        origin: "bundled",
        sourcePreferred: true,
      })?.modulePath ?? null;
    expect(withPluginCache(originalOwner, resolvePath)).toBe(candidates[0]);
    for (const candidate of candidates) {
      expect(withPluginCache(createPluginCache(), resolvePath)).toBe(candidate);
      fs.rmSync(candidate);
      expect(withPluginCache(originalOwner, resolvePath)).toBe(candidates[0]);
    }
    expect(withPluginCache(createPluginCache(), resolvePath)).toBeNull();
  });

  it.each([
    { configRepair: false, count: 0 },
    { configRepair: undefined, count: 1 },
    { configRepair: true, count: 1 },
  ])("gates config-repair artifacts: $configRepair", ({ configRepair, count }) => {
    const pluginRoot = mockContract(
      {
        legacyConfigRules: [{ path: ["plugins", "entries", "demo"], message: "demo rule" }],
        providerRenames,
      },
      {
        id: "test-plugin",
        providers: ["old", "new"],
        ...(configRepair === undefined ? {} : { doctorContract: { configRepair } }),
      },
    );

    expect(
      doctor.listPluginDoctorLegacyConfigRules({ workspaceDir: pluginRoot, env: {} }),
    ).toHaveLength(count);
    expect(doctor.resolvePluginDoctorProviderRenames({ pluginIds: ["old"], env: {} })).toHaveLength(
      count,
    );
    expect(mocks.createJiti).toHaveBeenCalledTimes(count);
  });

  it("rejects provider renames outside the plugin's declared providers", () => {
    const root = mockContract(
      { providerRenames },
      {
        id: "owner",
        providers: ["old"],
        doctorContract: { configRepair: true },
      },
    );
    expect(doctor.resolvePluginDoctorProviderRenames({ pluginIds: ["old"], env: {} })).toEqual([]);
    expect(doctorContractWarnMock).toHaveBeenCalledWith(
      expect.stringContaining(
        `failed to load doctor contract for owner from ${path.join(root, "doctor-contract-api.ts")}: Provider renames must belong to the plugin's declared providers.`,
      ),
    );
  });

  it("defers declared provider renames during compatibility preflight", () => {
    mockContract(
      { providerRenames },
      {
        id: "rename-owner",
        providers: ["old", "new"],
        doctorContract: { configRepair: true },
      },
    );
    const config: OpenClawConfig = {
      models: {
        providers: {
          old: {
            baseUrl: "https://models.example",
            api: "openai-completions",
            models: [],
          },
        },
      },
      agents: { defaults: { model: "old/model@old:default" } },
      auth: { profiles: { "old:default": { provider: "old", mode: "api_key" } } },
    };
    const original = structuredClone(config);
    const result = doctor.applyPluginDoctorCompatibilityMigrations(config, {
      env: {},
      pluginIds: ["old"],
    });
    expect([result.config, result.changes]).toEqual([original, []]);
    expect(config).toEqual(original);
    expect(mocks.createJiti).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])("isolates a normalizer-only config repair (throws=%s)", (throws) => {
    mockContract(
      {
        normalizeCompatibilityConfig: ({ cfg }: { cfg: Record<string, unknown> }) => {
          cfg.repaired = true;
          if (throws) {
            throw new Error("fixture repair failed");
          }
          return { config: cfg, changes: ["repaired config"] };
        },
      },
      {
        id: "normalizer-only",
        doctorContract: { configRepair: true },
      },
    );

    const config = {};
    const result = doctor.applyPluginDoctorCompatibilityMigrations(config, { env: {} });
    expect(config).toEqual({});
    expect(result).toEqual(
      throws
        ? {
            config: {},
            changes: [],
            warnings: [
              expect.stringContaining(
                'Plugin "normalizer-only" config repair failed: fixture repair failed',
              ),
            ],
          }
        : { config: { repaired: true }, changes: ["repaired config"] },
    );
    expect(mocks.createJiti).toHaveBeenCalledTimes(1);
  });

  it("retains warning-only repairs without publishing their candidate", () => {
    mockContract(
      {
        normalizeCompatibilityConfig: ({ cfg }: { cfg: Record<string, unknown> }) => {
          cfg.unreported = true;
          return { config: cfg, changes: [], warnings: ["Repair requires operator input."] };
        },
      },
      { id: "warning-only" },
    );

    const config = {};
    expect(doctor.applyPluginDoctorCompatibilityMigrations(config, { env: {} })).toEqual({
      config,
      changes: [],
      warnings: ["Repair requires operator input."],
    });
    expect(config).toEqual({});
  });

  it.each([
    { extension: "js", key: "legacy", message: "legacy demo key" },
    { extension: "ts", key: "ts", message: "typescript contract" },
  ])(
    "loads Windows $extension contracts through their compatible boundary",
    ({ extension, key, message }) => {
      const legacyConfigRules = [{ path: ["plugins", "entries", "demo", key], message }];
      const source =
        extension === "js"
          ? `module.exports = ${JSON.stringify({ legacyConfigRules })};\n`
          : `export const legacyConfigRules = ${JSON.stringify(legacyConfigRules)};\n`;
      const pluginRoot = writeContract(source, `contract-api.${extension}`);
      mocks.createJiti.mockImplementation(() => () => ({ legacyConfigRules }));
      mockDoctorPlugins({ id: "test-plugin", rootDir: pluginRoot });
      withMockedPlatform("win32", () => {
        expect(
          doctor.listPluginDoctorLegacyConfigRules({ workspaceDir: pluginRoot, env: {} }),
        ).toEqual(legacyConfigRules);
      });
      expect(mocks.createJiti).toHaveBeenCalledTimes(extension === "ts" ? 1 : 0);
      if (extension === "ts") {
        expect(mocks.createJiti).toHaveBeenCalledWith(
          pathToFileURL(path.join(pluginRoot, "contract-api.ts"), { windows: true }).href,
          expect.objectContaining({ tryNative: false }),
        );
      }
    },
  );

  it("loads config-derived session-store agent IDs from doctor contract modules", () => {
    const pluginRoot = writeContract(
      "module.exports = { resolveSessionStoreAgentIds: ({ cfg }) => [cfg.plugins.entries.demo.config.agentId, 'voice', ' '] };\n",
      "doctor-contract-api.cjs",
    );
    mockDoctorPlugins({ id: "test-plugin", packageName: "@openclaw/demo", rootDir: pluginRoot });

    expect(
      doctor.listPluginDoctorSessionStoreAgentIds({
        config: { plugins: { entries: { demo: { config: { agentId: "cards" } } } } },
        workspaceDir: pluginRoot,
        env: {},
        pluginIds: ["@openclaw/demo"],
      }),
    ).toEqual(["cards", "voice"]);
  });

  it("deduplicates manifest owners by first id and sorts them by id", () => {
    mockDoctorPlugins(
      ...(
        [
          ["google", "google", "Google"],
          ["anthropic", "anthropic", "Anthropic"],
          ["google-shadow", "google", "Ignored duplicate"],
        ] as const
      ).map(([id, ownerId, label]) => ({
        id,
        rootDir: `/plugins/${id}`,
        sessionRouteStateOwners: [{ id: ownerId, label }],
      })),
    );

    expect(
      doctor.listPluginDoctorSessionRouteStateOwners({
        workspaceDir: "/workspace",
        env: {},
        pluginIds: ["anthropic", "google", "google-shadow"],
      }),
    ).toEqual([
      { id: "anthropic", label: "Anthropic" },
      { id: "google", label: "Google" },
    ]);
    expect(mocks.createJiti).not.toHaveBeenCalled();
  });

  it("reads doctor contracts from the current manifest registry on each call", () => {
    for (const id of ["first", "second"]) {
      const rootDir = writeContract(
        `module.exports = { legacyConfigRules: [{ path: ['plugins', 'entries', '${id}'], message: '${id} contract' }] };\n`,
        "doctor-contract-api.cjs",
      );
      mocks.loadPluginManifestRegistry.mockReturnValueOnce(
        registry({ id: `${id}-plugin`, rootDir }),
      );
    }
    for (const id of ["first", "second"]) {
      expect(
        doctor.listPluginDoctorLegacyConfigRules({ workspaceDir: "/workspace", env: {} }),
      ).toEqual([{ path: ["plugins", "entries", id], message: `${id} contract` }]);
    }
    expect(mocks.loadPluginManifestRegistry).toHaveBeenCalledTimes(2);
  });

  it.each([true, false, undefined])(
    "does not grant bundled migration descriptors to a selected external shadow (enabled: %s)",
    (enabled) => {
      mockExternalShadow(enabled === undefined);
      const config = enabled === undefined ? {} : { plugins: { entries: { matrix: { enabled } } } };

      expect(doctor.resolvePluginDoctorStateMigrationInventory({ config, env: {} })).toEqual({
        knownPluginIds: [],
        sessionStoreOwnerPluginIds: [],
        descriptors: [],
        unresolvedPluginIds: ["matrix"],
      });
    },
  );

  it("keeps a disabled bundled channel catalog-known without making it executable or unresolved", () => {
    const bundled = registry({
      id: "discord",
      rootDir: makeTempDir(),
      origin: "bundled",
      channels: ["discord"],
      providers: [],
      doctorContract: {
        stateMigrations: [{ id: "discord-legacy-channel-state" }],
      },
    });
    mocks.loadPluginManifestRegistry.mockReturnValueOnce(bundled).mockReturnValueOnce(bundled);
    const config = {
      channels: { discord: { enabled: false } },
      plugins: { entries: { discord: { enabled: false } } },
    };

    expect(doctor.resolvePluginDoctorStateMigrationInventory({ config, env: {} })).toEqual({
      knownPluginIds: ["discord"],
      sessionStoreOwnerPluginIds: [],
      descriptors: [],
      unresolvedPluginIds: [],
    });
  });
});

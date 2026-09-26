// Covers plugin doctor contract registry discovery and validation.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withMockedPlatform } from "../test-utils/vitest-spies.js";
import { resolvePluginDoctorContractArtifact } from "./doctor-contract-artifact.js";
import { createPluginCache, withPluginCache } from "./plugin-cache.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "./test-helpers/fs-fixtures.js";
import {
  getRegistryJitiMocks,
  resetRegistryJitiMocks,
} from "./test-helpers/registry-jiti-mocks.js";

const tempDirs: string[] = [];
const mocks = getRegistryJitiMocks();
const doctorContractWarnMock = vi.hoisted(() => vi.fn());
const retainedConfigDoctorMock = vi.hoisted(() => vi.fn());
vi.mock("./public-surface-loader.js", () => ({
  loadBundledPluginPublicArtifactModuleFromCandidatesSync: retainedConfigDoctorMock,
}));
vi.mock("../logging/subsystem.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../logging/subsystem.js")>();
  return {
    ...actual,
    createSubsystemLogger: (subsystem: string) => ({
      ...actual.createSubsystemLogger(subsystem),
      warn: doctorContractWarnMock,
    }),
  };
});

let applyPluginDoctorCompatibilityMigrations: typeof import("./doctor-contract-registry.js").applyPluginDoctorCompatibilityMigrations;
let clearPluginDoctorContractRegistryCache: typeof import("./doctor-contract-registry.test-fixtures.js").clearPluginDoctorContractRegistryCache;
let listPluginDoctorLegacyConfigRules: typeof import("./doctor-contract-registry.js").listPluginDoctorLegacyConfigRules;
let listPluginDoctorSessionRouteStateOwners: typeof import("./doctor-contract-registry.js").listPluginDoctorSessionRouteStateOwners;
let listPluginDoctorSessionStoreAgentIds: typeof import("./doctor-contract-registry.js").listPluginDoctorSessionStoreAgentIds;
let resolvePluginDoctorStateMigrationInventory: typeof import("./doctor-contract-registry.js").resolvePluginDoctorStateMigrationInventory;
let setPluginDoctorContractRegistryModuleLoaderFactoryForTest:
  | typeof import("./doctor-contract-registry.test-fixtures.js").setPluginDoctorContractRegistryModuleLoaderFactoryForTest
  | undefined;

function mockDoctorPlugins(...plugins: Record<string, unknown>[]): void {
  mocks.loadPluginManifestRegistry.mockReturnValue({ plugins, diagnostics: [] });
}

function makeTempDir(): string {
  return makeTrackedTempDir("openclaw-doctor-contract-registry", tempDirs);
}

function requireFirstCreateJitiCall(): [string, { tryNative?: boolean }] {
  const call = mocks.createJiti.mock.calls[0];
  if (!call) {
    throw new Error("expected createJiti call");
  }
  return call as [string, { tryNative?: boolean }];
}

afterEach(() => {
  setPluginDoctorContractRegistryModuleLoaderFactoryForTest?.(undefined);
  cleanupTrackedTempDirs(tempDirs);
});

describe("doctor-contract-registry module loader", () => {
  beforeAll(async () => {
    vi.resetModules();
    ({
      applyPluginDoctorCompatibilityMigrations,
      listPluginDoctorLegacyConfigRules,
      listPluginDoctorSessionRouteStateOwners,
      listPluginDoctorSessionStoreAgentIds,
      resolvePluginDoctorStateMigrationInventory,
    } = await import("./doctor-contract-registry.js"));
    ({
      clearPluginDoctorContractRegistryCache,
      setPluginDoctorContractRegistryModuleLoaderFactoryForTest,
    } = await import("./doctor-contract-registry.test-fixtures.js"));
  });

  beforeEach(() => {
    resetRegistryJitiMocks();
    mockDoctorPlugins();
    doctorContractWarnMock.mockReset();
    retainedConfigDoctorMock.mockReset().mockReturnValue(null);
    // Loaded once in beforeAll; afterEach guards the same binding optionally because it
    // can fire when that import never completed. Fail loudly here instead of silently
    // running a case against the real module loader.
    if (!setPluginDoctorContractRegistryModuleLoaderFactoryForTest) {
      throw new Error("doctor contract registry test fixtures were not loaded");
    }
    setPluginDoctorContractRegistryModuleLoaderFactoryForTest(mocks.createJiti);
    clearPluginDoctorContractRegistryCache();
  });

  it("preserves source artifact precedence across root and dist candidates", () => {
    const pluginRoot = makeTempDir();
    const distRoot = path.join(pluginRoot, "dist");
    fs.mkdirSync(distRoot);
    const candidates = [
      "doctor-contract-api.ts",
      "dist/doctor-contract-api.ts",
      "doctor-contract-api.mts",
      "dist/doctor-contract-api.mts",
      "doctor-contract-api.cts",
      "dist/doctor-contract-api.cts",
      "doctor-contract-api.js",
      "dist/doctor-contract-api.js",
      "doctor-contract-api.mjs",
      "dist/doctor-contract-api.mjs",
      "doctor-contract-api.cjs",
      "dist/doctor-contract-api.cjs",
      "contract-api.ts",
      "dist/contract-api.ts",
      "contract-api.mts",
      "dist/contract-api.mts",
      "contract-api.cts",
      "dist/contract-api.cts",
      "contract-api.js",
      "dist/contract-api.js",
      "contract-api.mjs",
      "dist/contract-api.mjs",
      "contract-api.cjs",
      "dist/contract-api.cjs",
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
    {
      name: "declared false skips loading",
      doctorContract: { configRepair: false },
      expectedRuleCount: 0,
      expectedLoadCount: 0,
    },
    {
      name: "absent declaration preserves loading",
      doctorContract: undefined,
      expectedRuleCount: 1,
      expectedLoadCount: 1,
    },
    {
      name: "declared true loads the authoritative module",
      doctorContract: { configRepair: true },
      expectedRuleCount: 1,
      expectedLoadCount: 1,
    },
  ])("gates config-repair artifacts: $name", (testCase) => {
    const pluginRoot = makeTempDir();
    fs.writeFileSync(path.join(pluginRoot, "doctor-contract-api.ts"), "export {};\n", "utf-8");
    mocks.createJiti.mockImplementation(() => () => ({
      legacyConfigRules: [{ path: ["plugins", "entries", "demo"], message: "demo rule" }],
    }));
    mockDoctorPlugins({
      id: "test-plugin",
      rootDir: pluginRoot,
      ...(testCase.doctorContract ? { doctorContract: testCase.doctorContract } : {}),
    });

    expect(listPluginDoctorLegacyConfigRules({ workspaceDir: pluginRoot, env: {} })).toHaveLength(
      testCase.expectedRuleCount,
    );
    expect(mocks.createJiti).toHaveBeenCalledTimes(testCase.expectedLoadCount);
  });

  it.each([false, true])("isolates a normalizer-only config repair (throws=%s)", (throws) => {
    const pluginRoot = makeTempDir();
    fs.writeFileSync(path.join(pluginRoot, "doctor-contract-api.ts"), "export {};\n", "utf-8");
    mocks.createJiti.mockImplementation(() => () => ({
      normalizeCompatibilityConfig: ({ cfg }: { cfg: Record<string, unknown> }) => {
        cfg.repaired = true;
        if (throws) {
          throw new Error("fixture repair failed");
        }
        return { config: cfg, changes: ["repaired config"] };
      },
    }));
    mocks.loadPluginManifestRegistry.mockReturnValue({
      plugins: [
        {
          id: "normalizer-only",
          rootDir: pluginRoot,
          doctorContract: { configRepair: true },
        },
      ],
      diagnostics: [],
    });

    const config = {};
    const result = applyPluginDoctorCompatibilityMigrations(config, { env: {} });
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

  it("records doctor contract load failures with plugin and artifact context", () => {
    const pluginRoot = makeTempDir();
    const contractSource = path.join(pluginRoot, "doctor-contract-api.ts");
    fs.writeFileSync(contractSource, "export {};\n", "utf-8");
    mocks.createJiti.mockImplementation(() => () => {
      throw new Error("fixture module load failed");
    });
    mockDoctorPlugins({
      id: "broken-doctor-plugin",
      rootDir: pluginRoot,
      doctorContract: { configRepair: true },
    });

    expect(listPluginDoctorLegacyConfigRules({ workspaceDir: pluginRoot, env: {} })).toEqual([]);
    expect(doctorContractWarnMock).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining(
        `failed to load doctor contract for broken-doctor-plugin from ${contractSource}: fixture module load failed`,
      ),
    );
  });

  it("uses native require on Windows for compatible JavaScript contract-api modules", () => {
    const pluginRoot = makeTempDir();
    fs.writeFileSync(
      path.join(pluginRoot, "contract-api.js"),
      "module.exports = { legacyConfigRules: [{ path: ['plugins', 'entries', 'demo', 'legacy'], message: 'legacy demo key' }] };\n",
      "utf-8",
    );
    mockDoctorPlugins({ id: "test-plugin", rootDir: pluginRoot });
    withMockedPlatform("win32", () => {
      expect(
        listPluginDoctorLegacyConfigRules({
          workspaceDir: pluginRoot,
          env: {},
        }),
      ).toEqual([
        {
          path: ["plugins", "entries", "demo", "legacy"],
          message: "legacy demo key",
        },
      ]);
    });

    expect(mocks.createJiti).not.toHaveBeenCalled();
  });

  it("falls back to the source-transform boundary on Windows for TypeScript contract-api modules", () => {
    const pluginRoot = makeTempDir();
    const contractApiPath = path.join(pluginRoot, "contract-api.ts");
    fs.writeFileSync(
      contractApiPath,
      "export const legacyConfigRules = [{ path: ['plugins', 'entries', 'demo', 'ts'], message: 'typescript contract' }];\n",
      "utf-8",
    );
    mocks.createJiti.mockImplementation(() => () => ({
      legacyConfigRules: [
        {
          path: ["plugins", "entries", "demo", "ts"],
          message: "typescript contract",
        },
      ],
    }));
    mockDoctorPlugins({ id: "test-plugin", rootDir: pluginRoot });
    withMockedPlatform("win32", () => {
      expect(
        listPluginDoctorLegacyConfigRules({
          workspaceDir: pluginRoot,
          env: {},
        }),
      ).toEqual([
        {
          path: ["plugins", "entries", "demo", "ts"],
          message: "typescript contract",
        },
      ]);
    });

    expect(mocks.createJiti).toHaveBeenCalledTimes(1);
    const [jitiPath, jitiOptions] = requireFirstCreateJitiCall();
    expect(jitiPath).toBe(pathToFileURL(contractApiPath, { windows: true }).href);
    expect(jitiOptions.tryNative).toBe(false);
  });

  it("prefers doctor-contract-api over the broader contract-api surface", () => {
    const pluginRoot = makeTempDir();
    fs.writeFileSync(
      path.join(pluginRoot, "doctor-contract-api.cjs"),
      "module.exports = { legacyConfigRules: [{ path: ['plugins', 'entries', 'demo', 'doctor'], message: 'doctor contract' }] };\n",
      "utf-8",
    );
    fs.writeFileSync(
      path.join(pluginRoot, "contract-api.cjs"),
      "module.exports = { legacyConfigRules: [{ path: ['plugins', 'entries', 'demo', 'broad'], message: 'broad contract' }] };\n",
      "utf-8",
    );
    mockDoctorPlugins({ id: "test-plugin", rootDir: pluginRoot });

    withMockedPlatform("darwin", () => {
      expect(
        listPluginDoctorLegacyConfigRules({
          workspaceDir: pluginRoot,
          env: {},
        }),
      ).toEqual([
        {
          path: ["plugins", "entries", "demo", "doctor"],
          message: "doctor contract",
        },
      ]);
      expect(mocks.createJiti).not.toHaveBeenCalled();
    });
  });

  it("loads config-derived session-store agent IDs from doctor contract modules", () => {
    const pluginRoot = makeTempDir();
    fs.writeFileSync(
      path.join(pluginRoot, "doctor-contract-api.cjs"),
      "module.exports = { resolveSessionStoreAgentIds: ({ cfg }) => [cfg.plugins.entries.demo.config.agentId, 'voice', ' '] };\n",
      "utf-8",
    );
    mockDoctorPlugins({ id: "test-plugin", packageName: "@openclaw/demo", rootDir: pluginRoot });

    expect(
      listPluginDoctorSessionStoreAgentIds({
        config: {
          plugins: { entries: { demo: { config: { agentId: "cards" } } } },
        },
        workspaceDir: pluginRoot,
        env: {},
        pluginIds: ["@openclaw/demo"],
      }),
    ).toEqual(["cards", "voice"]);
  });

  it("deduplicates manifest owners by first id and sorts them by id", () => {
    mockDoctorPlugins(
      {
        id: "google",
        rootDir: "/plugins/google",
        sessionRouteStateOwners: [{ id: "google", label: "Google" }],
      },
      {
        id: "anthropic",
        rootDir: "/plugins/anthropic",
        sessionRouteStateOwners: [{ id: "anthropic", label: "Anthropic" }],
      },
      {
        id: "google-shadow",
        rootDir: "/plugins/google-shadow",
        sessionRouteStateOwners: [{ id: "google", label: "Ignored duplicate" }],
      },
    );

    expect(
      listPluginDoctorSessionRouteStateOwners({
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
    const firstRoot = makeTempDir();
    const secondRoot = makeTempDir();
    fs.writeFileSync(
      path.join(firstRoot, "doctor-contract-api.cjs"),
      "module.exports = { legacyConfigRules: [{ path: ['plugins', 'entries', 'first'], message: 'first contract' }] };\n",
      "utf-8",
    );
    fs.writeFileSync(
      path.join(secondRoot, "doctor-contract-api.cjs"),
      "module.exports = { legacyConfigRules: [{ path: ['plugins', 'entries', 'second'], message: 'second contract' }] };\n",
      "utf-8",
    );
    mocks.loadPluginManifestRegistry
      .mockReturnValueOnce({
        plugins: [{ id: "first-plugin", rootDir: firstRoot }],
        diagnostics: [],
      })
      .mockReturnValueOnce({
        plugins: [{ id: "second-plugin", rootDir: secondRoot }],
        diagnostics: [],
      });

    expect(listPluginDoctorLegacyConfigRules({ workspaceDir: "/workspace", env: {} })).toEqual([
      {
        path: ["plugins", "entries", "first"],
        message: "first contract",
      },
    ]);
    expect(listPluginDoctorLegacyConfigRules({ workspaceDir: "/workspace", env: {} })).toEqual([
      {
        path: ["plugins", "entries", "second"],
        message: "second contract",
      },
    ]);
    expect(mocks.loadPluginManifestRegistry).toHaveBeenCalledTimes(2);
  });

  it.each([true, false])(
    "does not grant bundled migration descriptors to a selected external shadow (enabled: %s)",
    (enabled) => {
      const bundledRoot = makeTempDir();
      const externalRoot = makeTempDir();
      const bundledRecord = {
        id: "matrix",
        rootDir: bundledRoot,
        origin: "bundled" as const,
        channels: [],
        providers: [],
        doctorContract: {
          stateMigrations: [{ id: "matrix-inbound-dedupe-to-claimable-dedupe" }],
        },
      };
      mocks.loadPluginManifestRegistry
        .mockReturnValueOnce({ plugins: [bundledRecord], diagnostics: [] })
        .mockReturnValueOnce({
          plugins: [{ ...bundledRecord, rootDir: externalRoot, origin: "global" }],
          diagnostics: [],
        });
      const config = {
        plugins: { entries: { matrix: { enabled } } },
      };

      expect(resolvePluginDoctorStateMigrationInventory({ config, env: {} })).toEqual({
        knownPluginIds: [],
        sessionStoreOwnerPluginIds: [],
        descriptors: [],
        unresolvedPluginIds: ["matrix"],
      });
    },
  );

  it("does not grant bundled migration descriptors to an implicitly selected external shadow", () => {
    const bundledRoot = makeTempDir();
    const externalRoot = makeTempDir();
    const bundledRecord = {
      id: "matrix",
      rootDir: bundledRoot,
      origin: "bundled" as const,
      channels: [],
      providers: [],
      doctorContract: {
        stateMigrations: [{ id: "matrix-inbound-dedupe-to-claimable-dedupe" }],
      },
    };
    mocks.loadPluginManifestRegistry
      .mockReturnValueOnce({ plugins: [bundledRecord], diagnostics: [] })
      .mockReturnValueOnce({
        plugins: [
          {
            ...bundledRecord,
            rootDir: externalRoot,
            origin: "global",
            enabledByDefault: true,
          },
        ],
        diagnostics: [],
      });

    expect(resolvePluginDoctorStateMigrationInventory({ config: {}, env: {} })).toEqual({
      knownPluginIds: [],
      sessionStoreOwnerPluginIds: [],
      descriptors: [],
      unresolvedPluginIds: ["matrix"],
    });
  });

  it("keeps a disabled bundled channel catalog-known without making it executable or unresolved", () => {
    const bundledRecord = {
      id: "discord",
      rootDir: makeTempDir(),
      origin: "bundled" as const,
      channels: ["discord"],
      providers: [],
      doctorContract: {
        stateMigrations: [{ id: "discord-legacy-channel-state" }],
      },
    };
    mocks.loadPluginManifestRegistry
      .mockReturnValueOnce({ plugins: [bundledRecord], diagnostics: [] })
      .mockReturnValueOnce({ plugins: [bundledRecord], diagnostics: [] });
    const config = {
      channels: { discord: { enabled: false } },
      plugins: { entries: { discord: { enabled: false } } },
    };

    expect(resolvePluginDoctorStateMigrationInventory({ config, env: {} })).toEqual({
      knownPluginIds: ["discord"],
      sessionStoreOwnerPluginIds: [],
      descriptors: [],
      unresolvedPluginIds: [],
    });
  });
});

// Covers plugin doctor contract registry discovery and validation.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withMockedPlatform } from "../test-utils/vitest-spies.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "./test-helpers/fs-fixtures.js";
import {
  getRegistryJitiMocks,
  resetRegistryJitiMocks,
} from "./test-helpers/registry-jiti-mocks.js";

const tempDirs: string[] = [];
const mocks = getRegistryJitiMocks();

let applyPluginDoctorCompatibilityMigrations: typeof import("./doctor-contract-registry.js").applyPluginDoctorCompatibilityMigrations;
let clearPluginDoctorContractRegistryCache: typeof import("./doctor-contract-registry.js").clearPluginDoctorContractRegistryCache;
let collectRelevantDoctorPluginIds: typeof import("./doctor-contract-registry.js").collectRelevantDoctorPluginIds;
let collectRelevantDoctorPluginIdsForTouchedPaths: typeof import("./doctor-contract-registry.js").collectRelevantDoctorPluginIdsForTouchedPaths;
let listPluginDoctorLegacyConfigRules: typeof import("./doctor-contract-registry.js").listPluginDoctorLegacyConfigRules;
let listPluginDoctorSessionRouteStateOwners: typeof import("./doctor-contract-registry.js").listPluginDoctorSessionRouteStateOwners;
let setPluginDoctorContractRegistryModuleLoaderFactoryForTest:
  | typeof import("./doctor-contract-registry.js").setPluginDoctorContractRegistryModuleLoaderFactoryForTest
  | undefined;

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
  beforeEach(async () => {
    resetRegistryJitiMocks();
    vi.resetModules();
    ({
      applyPluginDoctorCompatibilityMigrations,
      clearPluginDoctorContractRegistryCache,
      collectRelevantDoctorPluginIds,
      collectRelevantDoctorPluginIdsForTouchedPaths,
      listPluginDoctorLegacyConfigRules,
      listPluginDoctorSessionRouteStateOwners,
      setPluginDoctorContractRegistryModuleLoaderFactoryForTest,
    } = await import("./doctor-contract-registry.js"));
    setPluginDoctorContractRegistryModuleLoaderFactoryForTest(mocks.createJiti);
    clearPluginDoctorContractRegistryCache();
  });

  it("uses native require on Windows for compatible JavaScript contract-api modules", () => {
    const pluginRoot = makeTempDir();
    fs.writeFileSync(
      path.join(pluginRoot, "contract-api.js"),
      "module.exports = { legacyConfigRules: [{ path: ['plugins', 'entries', 'demo', 'legacy'], message: 'legacy demo key' }] };\n",
      "utf-8",
    );
    mocks.loadPluginManifestRegistry.mockReturnValue({
      plugins: [{ id: "test-plugin", rootDir: pluginRoot }],
      diagnostics: [],
    });
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
    mocks.loadPluginManifestRegistry.mockReturnValue({
      plugins: [{ id: "test-plugin", rootDir: pluginRoot }],
      diagnostics: [],
    });
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
    mocks.loadPluginManifestRegistry.mockReturnValue({
      plugins: [{ id: "test-plugin", rootDir: pluginRoot }],
      diagnostics: [],
    });

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

  it("uses native require for compatible JavaScript contract modules", () => {
    const pluginRoot = makeTempDir();
    fs.writeFileSync(
      path.join(pluginRoot, "doctor-contract-api.cjs"),
      "module.exports = { legacyConfigRules: [{ path: ['plugins', 'entries', 'demo', 'legacy'], message: 'legacy demo key' }] };\n",
      "utf-8",
    );
    mocks.loadPluginManifestRegistry.mockReturnValue({
      plugins: [{ id: "test-plugin", rootDir: pluginRoot }],
      diagnostics: [],
    });

    withMockedPlatform("darwin", () => {
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
      expect(mocks.createJiti).not.toHaveBeenCalled();
    });
  });

  it("loads session route-state owners from doctor contract modules", () => {
    const pluginRoot = makeTempDir();
    fs.writeFileSync(
      path.join(pluginRoot, "doctor-contract-api.cjs"),
      "module.exports = { sessionRouteStateOwners: [{ id: 'demo', label: 'Demo', providerIds: ['demo'], runtimeIds: ['demo-cli'], cliSessionKeys: ['demo-cli'], authProfilePrefixes: ['demo:'] }] };\n",
      "utf-8",
    );
    mocks.loadPluginManifestRegistry.mockReturnValue({
      plugins: [{ id: "test-plugin", rootDir: pluginRoot }],
      diagnostics: [],
    });

    expect(
      listPluginDoctorSessionRouteStateOwners({
        workspaceDir: pluginRoot,
        env: {},
      }),
    ).toEqual([
      {
        id: "demo",
        label: "Demo",
        providerIds: ["demo"],
        runtimeIds: ["demo-cli"],
        cliSessionKeys: ["demo-cli"],
        authProfilePrefixes: ["demo:"],
      },
    ]);
  });

  it("loads multiple bundled CLI route-state owners from doctor contract modules", () => {
    const anthropicRoot = makeTempDir();
    const googleRoot = makeTempDir();
    fs.writeFileSync(
      path.join(anthropicRoot, "doctor-contract-api.cjs"),
      "module.exports = { sessionRouteStateOwners: [{ id: 'anthropic', label: 'Anthropic', providerIds: ['anthropic', 'claude-cli'], runtimeIds: ['claude-cli'], cliSessionKeys: ['claude-cli'], authProfilePrefixes: ['anthropic:', 'claude-cli:'] }] };\n",
      "utf-8",
    );
    fs.writeFileSync(
      path.join(googleRoot, "doctor-contract-api.cjs"),
      "module.exports = { sessionRouteStateOwners: [{ id: 'google', label: 'Google', providerIds: ['google', 'google-antigravity', 'google-gemini-cli', 'google-vertex'], runtimeIds: ['google-gemini-cli'], cliSessionKeys: ['google-gemini-cli', 'gemini-cli'], authProfilePrefixes: ['google:', 'google-antigravity:', 'google-gemini-cli:', 'google-vertex:', 'gemini-cli:'] }] };\n",
      "utf-8",
    );
    mocks.loadPluginManifestRegistry.mockReturnValue({
      plugins: [
        { id: "anthropic", rootDir: anthropicRoot },
        { id: "google", rootDir: googleRoot },
      ],
      diagnostics: [],
    });

    expect(
      listPluginDoctorSessionRouteStateOwners({
        workspaceDir: "/workspace",
        env: {},
        pluginIds: ["anthropic", "google"],
      }),
    ).toEqual([
      {
        id: "anthropic",
        label: "Anthropic",
        providerIds: ["anthropic", "claude-cli"],
        runtimeIds: ["claude-cli"],
        cliSessionKeys: ["claude-cli"],
        authProfilePrefixes: ["anthropic:", "claude-cli:"],
      },
      {
        id: "google",
        label: "Google",
        providerIds: ["google", "google-antigravity", "google-gemini-cli", "google-vertex"],
        runtimeIds: ["google-gemini-cli"],
        cliSessionKeys: ["google-gemini-cli", "gemini-cli"],
        authProfilePrefixes: [
          "google:",
          "google-antigravity:",
          "google-gemini-cli:",
          "google-vertex:",
          "gemini-cli:",
        ],
      },
    ]);
  });

  it("passes active config to manifest registry discovery", () => {
    const pluginRoot = makeTempDir();
    fs.writeFileSync(
      path.join(pluginRoot, "doctor-contract-api.cjs"),
      "module.exports = { legacyConfigRules: [{ path: ['plugins', 'entries', 'load-path-doctor', 'config', 'summaryModel'], message: 'load path contract' }] };\n",
      "utf-8",
    );
    mocks.loadPluginManifestRegistry.mockReturnValue({
      plugins: [{ id: "load-path-doctor", rootDir: pluginRoot }],
      diagnostics: [],
    });
    const config = {
      plugins: {
        load: { paths: [pluginRoot] },
        entries: {
          "load-path-doctor": {
            config: {
              summaryModel: "openai/gpt-5.4-mini",
            },
          },
        },
      },
    };

    expect(
      listPluginDoctorLegacyConfigRules({
        config,
        workspaceDir: "/workspace",
        env: {},
        pluginIds: ["load-path-doctor"],
      }),
    ).toEqual([
      {
        path: ["plugins", "entries", "load-path-doctor", "config", "summaryModel"],
        message: "load path contract",
      },
    ]);
    expect(mocks.loadPluginManifestRegistry).toHaveBeenCalledWith({
      config,
      workspaceDir: "/workspace",
      env: {},
      includeDisabled: true,
    });
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

  it("collects model provider ids for doctor compatibility migrations", () => {
    expect(
      collectRelevantDoctorPluginIds({
        models: {
          providers: {
            "ollama-cloud": {
              baseUrl: "https://ai.ollama.com",
            },
          },
        },
      }),
    ).toEqual(["ollama-cloud"]);
  });

  it("collects legacy plugins.config keys for doctor compatibility migrations", () => {
    expect(
      collectRelevantDoctorPluginIds({
        plugins: {
          config: {
            "xmemo-memory": {
              apiKey: "old-key",
            },
          },
        },
      }),
    ).toEqual(["xmemo-memory"]);
  });

  it("merges plugins.entries and plugins.config keys without duplicates", () => {
    expect(
      collectRelevantDoctorPluginIds({
        plugins: {
          entries: {
            "xmemo-memory": {},
          },
          config: {
            "xmemo-memory": {
              apiKey: "old-key",
            },
            "legacy-plugin": {},
          },
        },
      }),
    ).toEqual(["legacy-plugin", "xmemo-memory"]);
  });

  it("loads a plugin doctor contract when scoped by a contributed provider id", () => {
    const pluginRoot = makeTempDir();
    fs.writeFileSync(path.join(pluginRoot, "doctor-contract-api.ts"), "export {};\n", "utf-8");
    mocks.createJiti.mockImplementation(() => () => ({
      normalizeCompatibilityConfig: ({
        cfg,
      }: {
        cfg: { models?: { providers?: Record<string, Record<string, unknown>> } };
      }) => ({
        config: {
          ...cfg,
          models: {
            ...cfg.models,
            providers: {
              ...cfg.models?.providers,
              "ollama-cloud": {
                ...cfg.models?.providers?.["ollama-cloud"],
                baseUrl: "https://ollama.com",
              },
            },
          },
        },
        changes: ["normalized ollama cloud provider endpoint"],
      }),
    }));
    mocks.loadPluginManifestRegistry.mockReturnValue({
      plugins: [
        {
          id: "ollama",
          rootDir: pluginRoot,
          channels: [],
          providers: ["ollama", "ollama-cloud"],
        },
      ],
      diagnostics: [],
    });
    const config = {
      models: {
        providers: {
          "ollama-cloud": {
            baseUrl: "https://ai.ollama.com",
            models: [],
          },
        },
      },
    };

    const result = applyPluginDoctorCompatibilityMigrations(config, {
      config,
      env: {},
      pluginIds: ["ollama-cloud"],
    });

    expect(result.changes).toEqual(["normalized ollama cloud provider endpoint"]);
    expect(result.config.models?.providers?.["ollama-cloud"]).toEqual({
      baseUrl: "https://ollama.com",
      models: [],
    });
  });

  it("narrows touched-path doctor ids for scoped dry-run validation", () => {
    expect(
      collectRelevantDoctorPluginIdsForTouchedPaths({
        raw: {
          channels: {
            discord: {},
            telegram: {},
          },
          plugins: {
            entries: {
              "memory-wiki": {},
            },
            config: {
              "xmemo-memory": {},
            },
          },
          models: {
            providers: {
              "ollama-cloud": {},
            },
          },
          talk: {
            voiceId: "legacy-voice",
          },
        },
        touchedPaths: [
          ["channels", "discord", "token"],
          ["plugins", "entries", "memory-wiki", "enabled"],
          ["plugins", "config", "xmemo-memory", "apiKey"],
          ["models", "providers", "ollama-cloud", "baseUrl"],
          ["talk", "voiceId"],
        ],
      }),
    ).toEqual(["discord", "elevenlabs", "memory-wiki", "ollama-cloud", "xmemo-memory"]);
  });

  it("falls back to the full doctor-id set when touched paths are too broad", () => {
    expect(
      collectRelevantDoctorPluginIdsForTouchedPaths({
        raw: {
          channels: {
            discord: {},
            telegram: {},
          },
          plugins: {
            entries: {
              "memory-wiki": {},
            },
          },
        },
        touchedPaths: [["channels"]],
      }),
    ).toEqual(["discord", "memory-wiki", "telegram"]);
  });

  it("applies a plugin doctor migration discovered from plugins.config keys", () => {
    const pluginRoot = makeTempDir();
    fs.writeFileSync(path.join(pluginRoot, "doctor-contract-api.ts"), "export {};\n", "utf-8");
    mocks.createJiti.mockImplementation(() => () => ({
      normalizeCompatibilityConfig: ({
        cfg,
      }: {
        cfg: { plugins?: { config?: Record<string, unknown>; entries?: Record<string, unknown> } };
      }) => {
        const plugins = cfg.plugins ?? {};
        const legacy = plugins.config?.["xmemo-memory"];
        if (!legacy || typeof legacy !== "object") {
          return { config: cfg, changes: [] };
        }
        return {
          config: {
            ...cfg,
            plugins: {
              ...plugins,
              entries: {
                ...plugins.entries,
                "xmemo-memory": {
                  enabled: true,
                  config: legacy,
                },
              },
            },
          },
          changes: ["migrated xmemo-memory from plugins.config"],
        };
      },
    }));
    mocks.loadPluginManifestRegistry.mockReturnValue({
      plugins: [
        {
          id: "xmemo-memory",
          rootDir: pluginRoot,
          channels: [],
          providers: [],
        },
      ],
      diagnostics: [],
    });

    const config = {
      plugins: {
        config: {
          "xmemo-memory": {
            apiKey: "legacy-key",
          },
        },
      },
    } as OpenClawConfig;

    const pluginIds = collectRelevantDoctorPluginIds(config);
    expect(pluginIds).toEqual(["xmemo-memory"]);

    const result = applyPluginDoctorCompatibilityMigrations(config, {
      config,
      env: {},
      pluginIds,
    });

    expect(result.changes).toEqual(["migrated xmemo-memory from plugins.config"]);
    expect(result.config.plugins?.entries?.["xmemo-memory"]).toEqual({
      enabled: true,
      config: { apiKey: "legacy-key" },
    });
  });
});

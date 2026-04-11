import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "./test-helpers/fs-fixtures.js";
import {
  getRegistryJitiMocks,
  resetRegistryJitiMocks,
} from "./test-helpers/registry-jiti-mocks.js";

const tempDirs: string[] = [];
const mocks = getRegistryJitiMocks();

let clearPluginSetupRegistryCache: typeof import("./setup-registry.js").clearPluginSetupRegistryCache;
let resolvePluginSetupRegistry: typeof import("./setup-registry.js").resolvePluginSetupRegistry;
let runPluginSetupConfigMigrations: typeof import("./setup-registry.js").runPluginSetupConfigMigrations;

function makeTempDir(): string {
  return makeTrackedTempDir("openclaw-setup-registry", tempDirs);
}

afterEach(() => {
  cleanupTrackedTempDirs(tempDirs);
});

describe("setup-registry getJiti", () => {
  beforeAll(async () => {
    ({ clearPluginSetupRegistryCache, resolvePluginSetupRegistry, runPluginSetupConfigMigrations } =
      await import("./setup-registry.js"));
  });

  beforeEach(() => {
    resetRegistryJitiMocks();
    clearPluginSetupRegistryCache();
  });

  it("disables native jiti loading on Windows for setup-api modules", () => {
    const pluginRoot = makeTempDir();
    fs.writeFileSync(path.join(pluginRoot, "setup-api.js"), "export default {};\n", "utf-8");
    mocks.loadPluginManifestRegistry.mockReturnValue({
      plugins: [{ id: "test-plugin", rootDir: pluginRoot }],
      diagnostics: [],
    });
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");

    try {
      resolvePluginSetupRegistry({
        workspaceDir: pluginRoot,
        env: {},
      });
    } finally {
      platformSpy.mockRestore();
    }

    expect(mocks.createJiti).toHaveBeenCalledTimes(1);
    expect(mocks.createJiti.mock.calls[0]?.[0]).toBe(path.join(pluginRoot, "setup-api.js"));
    expect(mocks.createJiti.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        tryNative: false,
      }),
    );
  });

  it("skips setup-api loading when config has no relevant migration triggers", () => {
    const pluginRoot = makeTempDir();
    fs.writeFileSync(path.join(pluginRoot, "setup-api.js"), "export default {};\n", "utf-8");
    mocks.loadPluginManifestRegistry.mockReturnValue({
      plugins: [
        {
          id: "amazon-bedrock",
          rootDir: pluginRoot,
          configContracts: {
            compatibilityMigrationPaths: ["models.bedrockDiscovery"],
          },
        },
      ],
      diagnostics: [],
    });
    mocks.createJiti.mockImplementation(() => {
      return () => ({
        default: {
          register(api: {
            registerConfigMigration: (migrate: (config: unknown) => unknown) => void;
          }) {
            api.registerConfigMigration((config) => ({ config, changes: ["unexpected"] }));
          },
        },
      });
    });

    const result = runPluginSetupConfigMigrations({
      config: {
        models: {
          providers: {
            openai: { baseUrl: "https://api.openai.com/v1" },
          },
        },
      } as never,
      env: {},
    });

    expect(result.changes).toEqual([]);
    expect(mocks.createJiti).not.toHaveBeenCalled();
  });

  it("loads only plugins whose manifest migration triggers match the config", () => {
    const bedrockRoot = makeTempDir();
    const voiceCallRoot = makeTempDir();
    fs.writeFileSync(path.join(bedrockRoot, "setup-api.js"), "export default {};\n", "utf-8");
    fs.writeFileSync(path.join(voiceCallRoot, "setup-api.js"), "export default {};\n", "utf-8");
    mocks.loadPluginManifestRegistry.mockReturnValue({
      plugins: [
        {
          id: "amazon-bedrock",
          rootDir: bedrockRoot,
          configContracts: {
            compatibilityMigrationPaths: ["models.bedrockDiscovery"],
          },
        },
        {
          id: "voice-call",
          rootDir: voiceCallRoot,
          configContracts: {
            compatibilityMigrationPaths: ["plugins.entries.voice-call.config"],
          },
        },
      ],
      diagnostics: [],
    });
    mocks.createJiti.mockImplementation((modulePath: string) => {
      const pluginId = modulePath.includes(bedrockRoot) ? "amazon-bedrock" : "voice-call";
      return () => ({
        default: {
          register(api: {
            registerConfigMigration: (migrate: (config: unknown) => unknown) => void;
          }) {
            api.registerConfigMigration((config) => ({
              config,
              changes: [pluginId],
            }));
          },
        },
      });
    });

    const result = runPluginSetupConfigMigrations({
      config: {
        models: {
          bedrockDiscovery: {
            enabled: true,
          },
        },
      } as never,
      env: {},
    });

    expect(result.changes).toEqual(["amazon-bedrock"]);
    expect(mocks.createJiti).toHaveBeenCalledTimes(1);
    expect(mocks.createJiti.mock.calls[0]?.[0]).toBe(path.join(bedrockRoot, "setup-api.js"));
  });

  it("still loads explicitly configured plugin entries without manifest trigger metadata", () => {
    const pluginRoot = makeTempDir();
    fs.writeFileSync(path.join(pluginRoot, "setup-api.js"), "export default {};\n", "utf-8");
    mocks.loadPluginManifestRegistry.mockReturnValue({
      plugins: [{ id: "voice-call", rootDir: pluginRoot }],
      diagnostics: [],
    });
    mocks.createJiti.mockImplementation(() => {
      return () => ({
        default: {
          register(api: {
            registerConfigMigration: (migrate: (config: unknown) => unknown) => void;
          }) {
            api.registerConfigMigration((config) => ({ config, changes: ["voice-call"] }));
          },
        },
      });
    });

    const result = runPluginSetupConfigMigrations({
      config: {
        plugins: {
          entries: {
            "voice-call": {
              config: {
                provider: "log",
              },
            },
          },
        },
      } as never,
      env: {},
    });

    expect(result.changes).toEqual(["voice-call"]);
    expect(mocks.createJiti).toHaveBeenCalledTimes(1);
  });
});

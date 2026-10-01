// Covers registered config migration selection, sequencing, and candidate isolation.
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  getRegistryJitiMocks,
  resetRegistryJitiMocks,
} from "./test-helpers/registry-jiti-mocks.js";

// Registry tests script exports at module binding; real setup ownership stays active.
vi.mock("./plugin-instance-module-loader.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./plugin-instance-module-loader.js")>();
  const { getCachedPluginModuleLoader } = await import("./plugin-module-loader-cache.js");
  return {
    ...actual,
    bindPluginInstanceModuleLoader: (
      params: Parameters<typeof actual.bindPluginInstanceModuleLoader>[0],
    ) =>
      params.instance.bindModuleLoader(
        getCachedPluginModuleLoader({
          modulePath: params.source,
          importerUrl: import.meta.url,
          tryNative: false,
          createLoader: getRegistryJitiMocks().createJiti,
        }),
      ),
  };
});

const mocks = getRegistryJitiMocks();
type SetupRegistryApi = Pick<import("./types.js").OpenClawPluginApi, "registerConfigMigration">;
let runPluginSetupConfigMigrations: typeof import("./setup-registry.js").runPluginSetupConfigMigrations;
let clearPluginSetupRegistryCache: typeof import("./setup-registry.test-fixtures.js").clearPluginSetupRegistryCache;
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(() => {
    clearPluginSetupRegistryCache();
    cleanup();
  }),
);

beforeAll(async () => {
  resetRegistryJitiMocks();
  // The shared plugin worker may have loaded setup before this file installed its mocks.
  vi.resetModules();
  ({ runPluginSetupConfigMigrations } = await import("./setup-registry.js"));
  ({ clearPluginSetupRegistryCache } = await import("./setup-registry.test-fixtures.js"));
});

beforeEach(() => {
  resetRegistryJitiMocks();
  clearPluginSetupRegistryCache();
});

describe("registered setup config migrations", () => {
  it("skips setup-api loading when config has no relevant migration triggers", () => {
    const pluginRoot = tempDirs.make("openclaw-setup-migrations-");
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
          register(api: SetupRegistryApi) {
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

    expect(result.changes).toStrictEqual([]);
    expect(mocks.createJiti).not.toHaveBeenCalled();
  });

  it("loads only plugins whose manifest migration triggers match the config", () => {
    const bedrockRoot = tempDirs.make("openclaw-setup-migrations-");
    const voiceCallRoot = tempDirs.make("openclaw-setup-migrations-");
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
          register(api: SetupRegistryApi) {
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
    const pluginRoot = tempDirs.make("openclaw-setup-migrations-");
    fs.writeFileSync(path.join(pluginRoot, "setup-api.js"), "export default {};\n", "utf-8");
    mocks.loadPluginManifestRegistry.mockReturnValue({
      plugins: [{ id: "voice-call", rootDir: pluginRoot }],
      diagnostics: [],
    });
    mocks.createJiti.mockImplementation(() => () => ({
      default: {
        register(api: SetupRegistryApi) {
          api.registerConfigMigration((config) => ({ config, changes: ["voice-call"] }));
        },
      },
    }));

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

  it.each([false, true])("isolates registered migration candidates (throws=%s)", (throws) => {
    const pluginRoot = tempDirs.make("openclaw-setup-migrations-");
    fs.writeFileSync(path.join(pluginRoot, "setup-api.js"), "export default {};\n", "utf-8");
    mocks.loadPluginManifestRegistry.mockReturnValue({
      plugins: [{ id: "fixture", rootDir: pluginRoot }],
      diagnostics: [],
    });
    mocks.createJiti.mockImplementation(() => () => ({
      default: {
        register(api: SetupRegistryApi) {
          api.registerConfigMigration((config) => ({
            config: { ...config, gateway: { port: 18789 } },
            changes: ["first"],
          }));
          api.registerConfigMigration((config) => {
            config.gateway = { port: 19999 };
            if (throws) {
              throw new Error("fixture migration failed");
            }
            return null;
          });
          api.registerConfigMigration((config) => ({
            config: { ...config, gateway: { ...config.gateway, bind: "loopback" } },
            changes: ["last"],
          }));
        },
      },
    }));
    const config = { plugins: { entries: { fixture: {} } } };
    const result = runPluginSetupConfigMigrations({ config, env: {} });

    expect(result.config.gateway).toEqual({ port: 18789, bind: "loopback" });
    expect(result.changes).toEqual(["first", "last"]);
    expect(result.warnings ?? []).toEqual(
      throws ? [expect.stringContaining('Plugin "fixture" config repair failed')] : [],
    );
    expect(config).toEqual({ plugins: { entries: { fixture: {} } } });
  });
});

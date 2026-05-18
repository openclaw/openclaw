import fsNode from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { clearCurrentPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-snapshot.js";
import { readPersistedInstalledPluginIndex } from "../plugins/installed-plugin-index-store.js";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import { clearLoadPluginMetadataSnapshotMemo } from "../plugins/plugin-metadata-snapshot.js";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import { CONFIG_CLOBBER_SNAPSHOT_LIMIT } from "./io.clobber-snapshot.js";
import {
  createConfigIO,
  getRuntimeConfigSourceSnapshot,
  registerConfigWriteListener,
  resetConfigRuntimeState,
  setRuntimeConfigSnapshot,
  writeConfigFile,
} from "./io.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "./types.openclaw.js";

// Mock the plugin manifest registry so we can register a fake channel whose
// AJV JSON Schema carries a `default` value.  This lets the #56772 regression
// test exercise the exact code path that caused the bug: AJV injecting
// defaults during the write-back validation pass.
const mockLoadPluginManifestRegistry = vi.hoisted(() =>
  vi.fn(
    (): PluginManifestRegistry => ({
      diagnostics: [],
      plugins: [],
    }),
  ),
);
const mockMaintainConfigBackups = vi.hoisted(() =>
  vi.fn<typeof import("./backup-rotation.js").maintainConfigBackups>(async () => {}),
);

vi.mock("../plugins/manifest-registry.js", () => ({
  loadPluginManifestRegistry: mockLoadPluginManifestRegistry,
}));

vi.mock("../plugins/plugin-registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugins/plugin-registry.js")>();
  return {
    ...actual,
    loadPluginManifestRegistryForPluginRegistry: mockLoadPluginManifestRegistry,
  };
});

vi.mock("../plugins/doctor-contract-registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugins/doctor-contract-registry.js")>();
  return {
    ...actual,
    listPluginDoctorLegacyConfigRules: () => [],
    applyPluginDoctorCompatibilityMigrations: () => ({ next: null, changes: [] }),
  };
});

vi.mock("./backup-rotation.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./backup-rotation.js")>();
  return {
    ...actual,
    maintainConfigBackups: mockMaintainConfigBackups,
  };
});

describe("config io write", () => {
  const suiteRootTracker = createSuiteTempRootTracker({ prefix: "openclaw-config-io-" });
  const silentLogger = {
    warn: () => {},
    error: () => {},
  };

  async function withSuiteHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
    const home = await suiteRootTracker.make("case");
    return fn(home);
  }

  const mockEmptyPluginManifestRegistry = () => {
    mockLoadPluginManifestRegistry.mockReturnValue({
      diagnostics: [],
      plugins: [],
    } satisfies PluginManifestRegistry);
  };

  const mockChannelPluginManifestRegistry = (...channelIds: string[]) => {
    mockLoadPluginManifestRegistry.mockReturnValue({
      diagnostics: [],
      plugins: channelIds.map((channelId) => ({
        id: `test-${channelId}`,
        origin: "global",
        channels: [channelId],
        providers: [],
        cliBackends: [],
        skills: [],
        hooks: [],
        rootDir: path.join("/tmp", `openclaw-test-${channelId}`),
        source: path.join("/tmp", `openclaw-test-${channelId}`, "index.js"),
        manifestPath: path.join("/tmp", `openclaw-test-${channelId}`, "openclaw.plugin.json"),
        channelConfigs: {
          [channelId]: {
            schema: { type: "object", additionalProperties: true },
          },
        },
      })),
    } satisfies PluginManifestRegistry);
  };

  beforeAll(async () => {
    await suiteRootTracker.setup();

    // Default: return an empty plugin list so existing tests that don't need
    // plugin-owned channel schemas keep working unchanged.
    mockEmptyPluginManifestRegistry();
  });

  afterEach(() => {
    resetConfigRuntimeState();
    clearCurrentPluginMetadataSnapshot();
    clearLoadPluginMetadataSnapshotMemo();
    mockEmptyPluginManifestRegistry();
    mockMaintainConfigBackups.mockReset();
    mockMaintainConfigBackups.mockResolvedValue(undefined);
  });

  afterAll(async () => {
    resetConfigRuntimeState();
    await suiteRootTracker.cleanup();
  });

  const expectInputOwnerDisplayUnchanged = (input: Record<string, unknown>) => {
    expect((input.commands as Record<string, unknown>).ownerDisplay).toBe("hash");
  };

  const readPersistedCommands = async (configPath: string) => {
    const persisted = JSON.parse(await fs.readFile(configPath, "utf-8")) as {
      commands?: Record<string, unknown>;
    };
    return persisted.commands;
  };

  const requireRecord = (value: unknown, label: string): Record<string, unknown> => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`expected ${label} to be a record`);
    }
    return value as Record<string, unknown>;
  };

  const requireArray = (value: unknown, label: string): unknown[] => {
    if (!Array.isArray(value)) {
      throw new Error(`expected ${label} to be an array`);
    }
    return value;
  };

  const expectInstallRecord = (
    record: unknown,
    expected: { source: string; spec: string; installPath: string },
  ) => {
    const actual = requireRecord(record, "plugin install record");
    expect(actual.source).toBe(expected.source);
    expect(actual.spec).toBe(expected.spec);
    expect(actual.installPath).toBe(expected.installPath);
  };

  const expectConfigWriteRejected = async (promise: Promise<unknown>) => {
    try {
      await promise;
    } catch (error) {
      expect(requireRecord(error, "config write rejection").code).toBe("CONFIG_WRITE_REJECTED");
      return;
    }
    throw new Error("expected config write rejection");
  };

  const expectPersistedHashResult = (result: unknown) => {
    const persistedHash = requireRecord(result, "config write result").persistedHash;
    expect(typeof persistedHash).toBe("string");
    expect(persistedHash).not.toBe("");
  };

  const createFastConfigIO = (home: string) =>
    createConfigIO({
      env: { OPENCLAW_TEST_FAST: "1" } as NodeJS.ProcessEnv,
      homedir: () => home,
      logger: silentLogger,
    });

  function withHealthStateWriteFailure(healthPath: string): typeof fsNode {
    const writeFile = fsNode.promises.writeFile.bind(fsNode.promises);
    const writeFileSync = fsNode.writeFileSync.bind(fsNode);
    return {
      ...fsNode,
      promises: {
        ...fsNode.promises,
        writeFile: async (target, data, options) => {
          if (target === healthPath) {
            throw new Error("health write failed");
          }
          return await writeFile(target, data, options);
        },
      },
      writeFileSync: (target, data, options) => {
        if (target === healthPath) {
          throw new Error("health write failed");
        }
        return writeFileSync(target, data, options);
      },
    };
  }

  it("logs health-state write failures through public config reads", async () => {
    await withSuiteHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      const healthPath = path.join(home, ".openclaw", "logs", "config-health.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(
        configPath,
        `${JSON.stringify({ gateway: { mode: "local" } }, null, 2)}\n`,
        "utf-8",
      );
      const warn = vi.fn();
      const io = createConfigIO({
        configPath,
        env: { OPENCLAW_TEST_FAST: "1" } as NodeJS.ProcessEnv,
        fs: withHealthStateWriteFailure(healthPath),
        homedir: () => home,
        logger: { warn, error: vi.fn() },
      });

      const snapshot = await io.readConfigFileSnapshot();
      expect(snapshot.exists).toBe(true);
      expect(io.loadConfig().gateway).toEqual({ mode: "local" });

      const expectedHealthWarning = `Config health-state write failed: ${healthPath}: health write failed`;
      expect(warn.mock.calls).toEqual([[expectedHealthWarning], [expectedHealthWarning]]);
    });
  });

  it("refuses direct config writes in Nix mode without changing the file", async () => {
    await withSuiteHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      const initialRaw = `${JSON.stringify({ gateway: { mode: "local" } }, null, 2)}\n`;
      await fs.writeFile(configPath, initialRaw, "utf-8");
      const io = createConfigIO({
        configPath,
        env: {
          OPENCLAW_NIX_MODE: "1",
          OPENCLAW_TEST_FAST: "1",
        } as NodeJS.ProcessEnv,
        homedir: () => home,
        logger: silentLogger,
      });

      await expect(io.writeConfigFile({ gateway: { mode: "local", port: 19001 } })).rejects.toThrow(
        "Agent-first Nix setup: https://github.com/openclaw/nix-openclaw#quick-start",
      );

      await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(initialRaw);
    });
  });

  it("loads shipped plugin install config records without mutating config or plugin index", async () => {
    await withSuiteHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      const pluginDir = path.join(home, ".openclaw", "plugins", "demo");
      const manifestPath = path.join(pluginDir, "openclaw.plugin.json");
      const source = path.join(pluginDir, "index.ts");
      await fs.mkdir(pluginDir, { recursive: true });
      await fs.writeFile(source, "export function register() {}\n", "utf-8");
      await fs.writeFile(
        manifestPath,
        `${JSON.stringify({ id: "demo", configSchema: { type: "object" } }, null, 2)}\n`,
        "utf-8",
      );
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(
        configPath,
        `${JSON.stringify(
          {
            plugins: {
              entries: { demo: { enabled: true } },
              installs: {
                demo: {
                  source: "npm",
                  spec: "demo@1.0.0",
                  installPath: pluginDir,
                },
              },
            },
          },
          null,
          2,
        )}\n`,
        "utf-8",
      );
      mockLoadPluginManifestRegistry.mockReturnValue({
        diagnostics: [],
        plugins: [
          {
            id: "demo",
            origin: "global",
            channels: [],
            providers: [],
            cliBackends: [],
            skills: [],
            hooks: [],
            rootDir: pluginDir,
            source,
            manifestPath,
            configSchema: {
              type: "object",
            },
          },
        ],
      } satisfies PluginManifestRegistry);

      const io = createFastConfigIO(home);
      try {
        const initialRaw = await fs.readFile(configPath, "utf-8");
        const cfg = io.loadConfig();

        expectInstallRecord(cfg.plugins?.installs?.demo, {
          source: "npm",
          spec: "demo@1.0.0",
          installPath: pluginDir,
        });
        const snapshot = await io.readConfigFileSnapshot();
        expectInstallRecord(snapshot.sourceConfig.plugins?.installs?.demo, {
          source: "npm",
          spec: "demo@1.0.0",
          installPath: pluginDir,
        });
        expectInstallRecord(snapshot.runtimeConfig.plugins?.installs?.demo, {
          source: "npm",
          spec: "demo@1.0.0",
          installPath: pluginDir,
        });
        await expect(
          readPersistedInstalledPluginIndex({
            stateDir: path.join(home, ".openclaw"),
          }),
        ).resolves.toBeNull();
        await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(initialRaw);
      } finally {
        mockLoadPluginManifestRegistry.mockReturnValue({
          diagnostics: [],
          plugins: [],
        } satisfies PluginManifestRegistry);
      }
    });
  });

  it("migrates shipped plugin install config records into the plugin index during explicit writes", async () => {
    await withSuiteHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      const pluginDir = path.join(home, ".openclaw", "plugins", "demo");
      const manifestPath = path.join(pluginDir, "openclaw.plugin.json");
      const source = path.join(pluginDir, "index.ts");
      await fs.mkdir(pluginDir, { recursive: true });
      await fs.writeFile(source, "export function register() {}\n", "utf-8");
      await fs.writeFile(
        manifestPath,
        `${JSON.stringify({ id: "demo", configSchema: { type: "object" } }, null, 2)}\n`,
        "utf-8",
      );
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(
        configPath,
        `${JSON.stringify(
          {
            plugins: {
              entries: { demo: { enabled: true } },
              installs: {
                demo: {
                  source: "npm",
                  spec: "demo@1.0.0",
                  installPath: pluginDir,
                },
              },
            },
          },
          null,
          2,
        )}\n`,
        "utf-8",
      );
      mockLoadPluginManifestRegistry.mockReturnValue({
        diagnostics: [],
        plugins: [
          {
            id: "demo",
            origin: "global",
            channels: [],
            providers: [],
            cliBackends: [],
            skills: [],
            hooks: [],
            rootDir: pluginDir,
            source,
            manifestPath,
            configSchema: {
              type: "object",
            },
          },
        ],
      } satisfies PluginManifestRegistry);

      const io = createFastConfigIO(home);
      try {
        await io.writeConfigFile({
          plugins: {
            entries: { demo: { enabled: true } },
          },
        });

        const index = requireRecord(
          await readPersistedInstalledPluginIndex({
            stateDir: path.join(home, ".openclaw"),
          }),
          "persisted plugin index",
        );
        expectInstallRecord(requireRecord(index.installRecords, "install records").demo, {
          source: "npm",
          spec: "demo@1.0.0",
          installPath: pluginDir,
        });
        const plugins = requireArray(index.plugins, "plugin index plugins");
        expect(plugins).toHaveLength(1);
        const indexedPlugin = requireRecord(plugins[0], "indexed plugin");
        expect(indexedPlugin.pluginId).toBe("demo");
        expect(indexedPlugin.installRecordHash).toMatch(/^[a-f0-9]{64}$/u);
        const persistedConfig = JSON.parse(await fs.readFile(configPath, "utf-8")) as {
          plugins?: { installs?: unknown };
        };
        expect(persistedConfig.plugins?.installs).toBeUndefined();
      } finally {
        mockLoadPluginManifestRegistry.mockReturnValue({
          diagnostics: [],
          plugins: [],
        } satisfies PluginManifestRegistry);
      }
    });
  });

  it("migrates shipped plugin install config records during explicit writes even when the manifest is missing", async () => {
    await withSuiteHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      const pluginDir = path.join(home, ".openclaw", "plugins", "missing");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(
        configPath,
        `${JSON.stringify(
          {
            plugins: {
              entries: { missing: { enabled: true } },
              installs: {
                missing: {
                  source: "npm",
                  spec: "missing-plugin@1.0.0",
                  installPath: pluginDir,
                },
              },
            },
          },
          null,
          2,
        )}\n`,
        "utf-8",
      );

      const io = createFastConfigIO(home);
      await io.writeConfigFile({
        plugins: {
          entries: { missing: { enabled: true } },
        },
      });

      const index = requireRecord(
        await readPersistedInstalledPluginIndex({
          stateDir: path.join(home, ".openclaw"),
        }),
        "persisted plugin index",
      );
      expectInstallRecord(requireRecord(index.installRecords, "install records").missing, {
        source: "npm",
        spec: "missing-plugin@1.0.0",
        installPath: pluginDir,
      });
      expect(index.plugins).toEqual([]);
      const persistedConfig = JSON.parse(await fs.readFile(configPath, "utf-8")) as {
        plugins?: { installs?: unknown };
      };
      expect(persistedConfig.plugins?.installs).toBeUndefined();
    });
  });

  it("keeps shipped plugin install config records when index migration fails", async () => {
    await withSuiteHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      const unwritableStatePath = path.join(home, ".openclaw");
      const pluginDir = path.join(unwritableStatePath, "plugins", "demo");
      const original = {
        plugins: {
          entries: { demo: { enabled: true } },
          installs: {
            demo: {
              source: "npm",
              spec: "demo@1.0.0",
              installPath: pluginDir,
            },
          },
        },
      };
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(configPath, `${JSON.stringify(original, null, 2)}\n`, "utf-8");
      const warn = vi.fn();
      const io = createConfigIO({
        env: { OPENCLAW_TEST_FAST: "1" } as NodeJS.ProcessEnv,
        homedir: () => home,
        logger: { warn, error: vi.fn() },
      });
      await fs.writeFile(path.join(unwritableStatePath, "plugins"), "not a directory", "utf-8");

      const loadedConfig = io.loadConfig();
      expectInstallRecord(loadedConfig.plugins?.installs?.demo, {
        source: "npm",
        spec: "demo@1.0.0",
        installPath: pluginDir,
      });
      expect(warn.mock.calls).toEqual([
        [
          "Config warnings:\n- plugins.entries.demo: plugin not found: demo (stale config entry ignored; remove it from plugins config)",
        ],
      ]);

      await expect(io.writeConfigFile({ gateway: { mode: "local" } })).rejects.toThrow(
        "Config write blocked: shipped plugins.installs records",
      );

      const persisted = JSON.parse(await fs.readFile(configPath, "utf-8")) as typeof original;
      expectInstallRecord(persisted.plugins.installs.demo, {
        source: "npm",
        spec: "demo@1.0.0",
        installPath: pluginDir,
      });
    });
  });

  it("rolls back shipped plugin install index migration when config write fails", async () => {
    await withSuiteHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      const pluginDir = path.join(home, ".openclaw", "plugins", "demo");
      const original = {
        plugins: {
          entries: { demo: { enabled: true } },
          installs: {
            demo: {
              source: "npm",
              spec: "demo@1.0.0",
              installPath: pluginDir,
            },
          },
        },
      };
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(configPath, `${JSON.stringify(original, null, 2)}\n`, "utf-8");
      mockMaintainConfigBackups.mockRejectedValueOnce(new Error("backup failed"));

      const io = createFastConfigIO(home);
      await expect(io.writeConfigFile({ gateway: { mode: "local" } })).rejects.toThrow(
        "backup failed",
      );

      const persistedConfig = JSON.parse(await fs.readFile(configPath, "utf-8")) as typeof original;
      expectInstallRecord(persistedConfig.plugins.installs.demo, {
        source: "npm",
        spec: "demo@1.0.0",
        installPath: pluginDir,
      });
      await expect(
        readPersistedInstalledPluginIndex({
          stateDir: path.join(home, ".openclaw"),
        }),
      ).resolves.toBeNull();
    });
  });

  const writeGatewayPortAndReadConfig = async (home: string, configPath: string) => {
    const io = createFastConfigIO(home);

    await io.writeConfigFile({
      gateway: { mode: "local", port: 18789 },
    });

    return JSON.parse(await fs.readFile(configPath, "utf-8")) as {
      $schema?: string;
      gateway?: { mode?: string; port?: number };
    };
  };

  it.runIf(process.platform !== "win32")(
    "tightens world-writable state dir when writing the default config",
    async () => {
      await withSuiteHome(async (home) => {
        const stateDir = path.join(home, ".openclaw");
        await fs.mkdir(stateDir, { recursive: true, mode: 0o777 });
        await fs.chmod(stateDir, 0o777);

        const io = createConfigIO({
          env: {} as NodeJS.ProcessEnv,
          homedir: () => home,
          logger: silentLogger,
        });

        await io.writeConfigFile({ gateway: { mode: "local" } });

        const stat = await fs.stat(stateDir);
        expect(stat.mode & 0o777).toBe(0o700);
      });
    },
  );

  it("keeps writes inside an OPENCLAW_STATE_DIR override even when the real home config exists", async () => {
    await withSuiteHome(async (home) => {
      const liveConfigPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.mkdir(path.dirname(liveConfigPath), { recursive: true });
      await fs.writeFile(
        liveConfigPath,
        `${JSON.stringify({ gateway: { mode: "local", port: 18789 } }, null, 2)}\n`,
        "utf-8",
      );

      const overrideDir = path.join(home, "isolated-state");
      const env = { OPENCLAW_STATE_DIR: overrideDir } as NodeJS.ProcessEnv;
      const io = createConfigIO({
        env,
        homedir: () => home,
        logger: silentLogger,
      });

      expect(io.configPath).toBe(path.join(overrideDir, "openclaw.json"));

      await io.writeConfigFile({
        agents: { list: [{ id: "main", default: true }] },
        gateway: { mode: "local" },
        session: { mainKey: "main", store: path.join(overrideDir, "sessions.json") },
      });

      const livePersisted = JSON.parse(await fs.readFile(liveConfigPath, "utf-8")) as {
        gateway?: { mode?: unknown; port?: unknown };
      };
      expect(livePersisted.gateway).toEqual({ mode: "local", port: 18789 });

      const overridePersisted = JSON.parse(
        await fs.readFile(path.join(overrideDir, "openclaw.json"), "utf-8"),
      ) as {
        session?: { store?: unknown };
      };
      expect(overridePersisted.session?.store).toBe(path.join(overrideDir, "sessions.json"));
    });
  });

  it("does not mutate caller config when unsetPaths is applied on first write", async () => {
    await withSuiteHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      const io = createConfigIO({
        env: {} as NodeJS.ProcessEnv,
        homedir: () => home,
        logger: silentLogger,
      });

      const input: Record<string, unknown> = {
        gateway: { mode: "local" },
        commands: { ownerDisplay: "hash" },
      };

      await io.writeConfigFile(input, { unsetPaths: [["commands", "ownerDisplay"]] });

      expect(input).toEqual({
        gateway: { mode: "local" },
        commands: { ownerDisplay: "hash" },
      });
      expectInputOwnerDisplayUnchanged(input);
      expect((await readPersistedCommands(configPath)) ?? {}).not.toHaveProperty("ownerDisplay");
    });
  });

  it("does not log an overwrite audit entry when creating config for the first time", async () => {
    await withSuiteHome(async (home) => {
      const warn = vi.fn();
      const io = createConfigIO({
        env: {} as NodeJS.ProcessEnv,
        homedir: () => home,
        logger: {
          warn,
          error: vi.fn(),
        },
      });

      await io.writeConfigFile({
        gateway: { mode: "local" },
      });

      const overwriteLogs = warn.mock.calls.filter(
        (call) => typeof call[0] === "string" && call[0].startsWith("Config overwrite:"),
      );
      expect(overwriteLogs).toHaveLength(0);
    });
  });

  it("does not print overwrite audit output by default when updating config", async () => {
    await withSuiteHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(
        configPath,
        `${JSON.stringify({ gateway: { mode: "local", port: 18789 } }, null, 2)}\n`,
        "utf-8",
      );
      const warn = vi.fn();
      const io = createConfigIO({
        env: {} as NodeJS.ProcessEnv,
        homedir: () => home,
        logger: {
          warn,
          error: vi.fn(),
        },
      });

      await io.writeConfigFile({
        gateway: { mode: "local", port: 18790 },
      });

      const overwriteLogs = warn.mock.calls.filter(
        (call) => typeof call[0] === "string" && call[0].startsWith("Config overwrite:"),
      );
      expect(overwriteLogs).toHaveLength(0);
    });
  });

  it("suppresses overwrite audit output when skipOutputLogs is set", async () => {
    await withSuiteHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(
        configPath,
        `${JSON.stringify({ gateway: { mode: "local", port: 18789 } }, null, 2)}\n`,
        "utf-8",
      );
      const warn = vi.fn();
      const io = createConfigIO({
        env: {
          VITEST: "true",
          OPENCLAW_TEST_CONFIG_OVERWRITE_LOG: "1",
        } as NodeJS.ProcessEnv,
        homedir: () => home,
        logger: {
          warn,
          error: vi.fn(),
        },
      });

      await io.writeConfigFile(
        {
          gateway: { mode: "local", port: 18790 },
        },
        { skipOutputLogs: true },
      );

      const overwriteLogs = warn.mock.calls.filter(
        (call) => typeof call[0] === "string" && call[0].startsWith("Config overwrite:"),
      );
      expect(overwriteLogs).toHaveLength(0);
    });
  });

  it("preserves root $schema during partial writes", async () => {
    await withSuiteHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(
        configPath,
        `${JSON.stringify(
          {
            $schema: "https://openclaw.ai/config.json",
            gateway: { mode: "local" },
          },
          null,
          2,
        )}\n`,
        "utf-8",
      );

      const persisted = await writeGatewayPortAndReadConfig(home, configPath);
      expect(persisted.$schema).toBe("https://openclaw.ai/config.json");
      expect(persisted.gateway).toEqual({ mode: "local", port: 18789 });
    });
  });

  it("recovers configs polluted by a leading status line", async () => {
    await withSuiteHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      const cleanConfig = {
        gateway: { mode: "local" },
        agents: { list: [{ id: "main", default: true }, { id: "discord-dm" }] },
      } satisfies ConfigFileSnapshot["config"];
      const cleanRaw = `${JSON.stringify(cleanConfig, null, 2)}\n`;
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(configPath, `Found and updated: False\n${cleanRaw}`, "utf-8");
      const warn = vi.fn();
      const io = createConfigIO({
        env: { VITEST: "true" } as NodeJS.ProcessEnv,
        homedir: () => home,
        logger: { warn, error: vi.fn() },
      });

      const initialSnapshot = await io.readConfigFileSnapshot();
      expect(initialSnapshot.valid).toBe(false);

      await expect(io.recoverConfigFromJsonRootSuffix(initialSnapshot)).resolves.toBe(true);
      const recoveredSnapshot = await io.readConfigFileSnapshot();

      expect(recoveredSnapshot.valid).toBe(true);
      expect(recoveredSnapshot.config.gateway?.mode).toBe("local");
      expect(recoveredSnapshot.config.agents?.list?.map((entry) => entry.id)).toEqual([
        "main",
        "discord-dm",
      ]);
      await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(cleanRaw);
      const entries = await fs.readdir(path.dirname(configPath));
      const clobberedEntries = entries.filter((entry) => entry.includes(".clobbered."));
      expect(clobberedEntries).toHaveLength(1);
      expect(warn.mock.calls).toEqual([
        [
          `Config auto-stripped non-JSON prefix: ${configPath} (original saved as ${path.join(
            path.dirname(configPath),
            clobberedEntries[0] ?? "",
          )})`,
        ],
      ]);
    });
  });

  it("rotates repeated prefix-recovery clobber snapshots for doctor-style repair loops", async () => {
    await withSuiteHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      const cleanConfig = {
        gateway: { mode: "local" },
        agents: { list: [{ id: "main", default: true }] },
      } satisfies ConfigFileSnapshot["config"];
      const cleanRaw = `${JSON.stringify(cleanConfig, null, 2)}\n`;
      const warn = vi.fn();
      const io = createConfigIO({
        env: { VITEST: "true" } as NodeJS.ProcessEnv,
        homedir: () => home,
        logger: { warn, error: vi.fn() },
      });

      await fs.mkdir(path.dirname(configPath), { recursive: true });
      for (let index = 0; index < CONFIG_CLOBBER_SNAPSHOT_LIMIT + 4; index++) {
        await fs.writeFile(configPath, `Found and updated: False ${index}\n${cleanRaw}`, "utf-8");
        const snapshot = await io.readConfigFileSnapshot();
        expect(snapshot.valid).toBe(false);
        await expect(io.recoverConfigFromJsonRootSuffix(snapshot)).resolves.toBe(true);
      }

      const entries = await fs.readdir(path.dirname(configPath));
      const clobbered = entries.filter((entry) => entry.includes(".clobbered."));
      expect(clobbered).toHaveLength(CONFIG_CLOBBER_SNAPSHOT_LIMIT);
      const clobberedContents = await Promise.all(
        clobbered.map((entry) => fs.readFile(path.join(path.dirname(configPath), entry), "utf-8")),
      );
      expect(clobberedContents).not.toContain(`Found and updated: False 0\n${cleanRaw}`);
      expect(clobberedContents).toContain(
        `Found and updated: False ${CONFIG_CLOBBER_SNAPSHOT_LIMIT + 3}\n${cleanRaw}`,
      );
      const capWarnings = warn.mock.calls.filter(
        ([message]) =>
          typeof message === "string" && message.includes("Config clobber snapshot cap reached"),
      );
      expect(capWarnings).toHaveLength(1);
      await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(cleanRaw);
    });
  });

  it("rejects destructive internal writes before replacing the config", async () => {
    await withSuiteHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      const original = {
        gateway: { mode: "local" },
        channels: { telegram: { enabled: true, dmPolicy: "pairing" } },
        agents: { list: [{ id: "main", default: true, workspace: "/tmp/openclaw-main" }] },
        tools: { profile: "messaging" },
        commands: { ownerDisplay: "hash" },
      } satisfies ConfigFileSnapshot["config"];
      const originalRaw = `${JSON.stringify(original, null, 2)}\n`;
      await fs.writeFile(configPath, originalRaw, "utf-8");
      const warn = vi.fn();
      const io = createConfigIO({
        env: { VITEST: "true" } as NodeJS.ProcessEnv,
        homedir: () => home,
        logger: { warn, error: vi.fn() },
      });
      const baseSnapshot = {
        path: configPath,
        exists: true,
        raw: originalRaw,
        parsed: original,
        sourceConfig: original,
        resolved: original,
        valid: true,
        runtimeConfig: original,
        config: original,
        issues: [],
        warnings: [],
        legacyIssues: [],
      } satisfies ConfigFileSnapshot;

      await expectConfigWriteRejected(
        io.writeConfigFile(
          { update: { channel: "beta" } },
          {
            baseSnapshot,
          },
        ),
      );

      await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(originalRaw);
      const entries = await fs.readdir(path.dirname(configPath));
      const rejectedEntries = entries.filter((entry) => entry.includes(".rejected."));
      expect(rejectedEntries).toHaveLength(1);
      expect(warn.mock.calls).toEqual([
        [
          `Config write rejected: ${configPath} (gateway-mode-removed, protected-channel-config-changed:channels.telegram). Rejected payload saved to ${path.join(
            path.dirname(configPath),
            rejectedEntries[0] ?? "",
          )}.`,
        ],
      ]);
    });
  });

  it("allows intentional size-drop writes without disabling gateway-mode protection", async () => {
    await withSuiteHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      const original = {
        meta: { lastTouchedVersion: "2026.4.30" },
        gateway: { mode: "local" },
        channels: {
          telegram: {
            enabled: true,
            allowFrom: Array.from({ length: 80 }, (_, index) => `telegram:${index}`),
          },
        },
      } satisfies ConfigFileSnapshot["config"];
      const originalRaw = `${JSON.stringify(original, null, 2)}\n`;
      await fs.writeFile(configPath, originalRaw, "utf-8");
      const io = createConfigIO({
        env: { VITEST: "true" } as NodeJS.ProcessEnv,
        homedir: () => home,
        logger: silentLogger,
      });
      const baseSnapshot = {
        path: configPath,
        exists: true,
        raw: originalRaw,
        parsed: original,
        sourceConfig: original,
        resolved: original,
        valid: true,
        runtimeConfig: original,
        config: original,
        issues: [],
        warnings: [],
        legacyIssues: [],
      } satisfies ConfigFileSnapshot;

      const acceptedWrite = await io.writeConfigFile(
        { meta: original.meta, gateway: { mode: "local" } },
        {
          allowConfigSizeDrop: true,
          allowProtectedConfigPolicyDrop: true,
          baseSnapshot,
        },
      );
      expect(acceptedWrite.persistedConfig.gateway).toEqual({ mode: "local" });

      await expectConfigWriteRejected(
        io.writeConfigFile(
          { meta: original.meta },
          {
            allowConfigSizeDrop: true,
            baseSnapshot,
          },
        ),
      );
    });
  });

  it("rejects stale runtime writes that drop protected channel and elevated policy", async () => {
    await withSuiteHome(async (home) => {
      mockChannelPluginManifestRegistry("whatsapp");
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      const original = {
        meta: { lastTouchedVersion: "2026.5.17" },
        gateway: { mode: "local" },
        commands: {
          ownerAllowFrom: ["whatsapp:+15550001111", "telegram:111"],
        },
        tools: {
          elevated: {
            allowFrom: {
              webchat: ["session:trusted"],
            },
          },
        },
        agents: {
          list: [
            {
              id: "main",
              tools: {
                elevated: {
                  allowFrom: {
                    webchat: ["session:trusted"],
                  },
                },
              },
            },
          ],
        },
        channels: {
          whatsapp: {
            enabled: true,
            allowFrom: ["+15550001111", "+15550002222"],
            groupAllowFrom: ["+15550001111", "+15550002222"],
            accounts: {
              default: {
                allowFrom: ["+15550003333", "+15550004444"],
                groupAllowFrom: ["+15550003333", "+15550004444"],
              },
            },
          },
          telegram: {
            enabled: false,
            accounts: {
              default: {
                enabled: false,
              },
            },
          },
        },
      } satisfies ConfigFileSnapshot["config"];
      const staleRuntime = {
        ...original,
        commands: {},
        tools: {
          elevated: {
            allowFrom: {
              webchat: ["*"],
            },
          },
        },
        agents: {
          list: [
            {
              id: "main",
              tools: {
                elevated: {
                  allowFrom: {
                    webchat: ["*"],
                  },
                },
              },
            },
          ],
        },
        channels: {
          whatsapp: {
            enabled: false,
            allowFrom: ["+15550001111"],
            groupAllowFrom: ["+15550001111"],
            accounts: {
              default: {
                enabled: false,
                allowFrom: ["+15550003333"],
                groupAllowFrom: ["+15550003333"],
              },
            },
          },
          telegram: {
            enabled: true,
            accounts: {
              default: {
                enabled: true,
              },
            },
          },
        },
      } satisfies ConfigFileSnapshot["config"];
      const originalRaw = `${JSON.stringify(original, null, 2)}\n`;
      await fs.writeFile(configPath, originalRaw, "utf-8");
      const io = createConfigIO({
        env: { VITEST: "true" } as NodeJS.ProcessEnv,
        homedir: () => home,
        logger: silentLogger,
      });
      const baseSnapshot = {
        path: configPath,
        exists: true,
        raw: originalRaw,
        parsed: original,
        sourceConfig: original,
        resolved: original,
        valid: true,
        runtimeConfig: original,
        config: original,
        issues: [],
        warnings: [],
        legacyIssues: [],
      } satisfies ConfigFileSnapshot;

      await expect(io.writeConfigFile(staleRuntime, { baseSnapshot })).rejects.toMatchObject({
        code: "CONFIG_WRITE_REJECTED",
        reasons: expect.arrayContaining([
          "protected-command-policy-changed:commands.ownerAllowFrom",
          "protected-elevated-tools-changed:tools.elevated.allowFrom",
          "protected-agent-elevated-tools-changed:agents.list.main.tools.elevated.allowFrom",
          "protected-channel-config-changed:channels.whatsapp",
          "protected-channel-config-changed:channels.whatsapp.accounts.default",
          "protected-channel-config-changed:channels.telegram",
          "protected-channel-config-changed:channels.telegram.accounts.default",
        ]),
      });
      await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(originalRaw);
    });
  });

  it("compares protected policy against resolved includes for unrelated root writes", async () => {
    await withSuiteHome(async (home) => {
      mockChannelPluginManifestRegistry("whatsapp");
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      const authoredRoot = {
        gateway: { mode: "local" },
        channels: { $include: "./config/channels.json5" },
      };
      const sourceConfig = {
        gateway: { mode: "local" },
        channels: {
          whatsapp: {
            enabled: true,
            allowFrom: ["+15550001111"],
          },
        },
      } satisfies ConfigFileSnapshot["sourceConfig"];
      const rootRaw = `${JSON.stringify(authoredRoot, null, 2)}\n`;
      await fs.writeFile(configPath, rootRaw, "utf-8");
      const io = createConfigIO({
        env: { VITEST: "true" } as NodeJS.ProcessEnv,
        homedir: () => home,
        logger: silentLogger,
      });
      const baseSnapshot = {
        path: configPath,
        exists: true,
        raw: rootRaw,
        parsed: authoredRoot,
        sourceConfig,
        resolved: sourceConfig,
        valid: true,
        runtimeConfig: sourceConfig,
        config: sourceConfig,
        issues: [],
        warnings: [],
        legacyIssues: [],
      } satisfies ConfigFileSnapshot;

      await expect(
        io.writeConfigFile(
          {
            ...sourceConfig,
            gateway: { mode: "local", port: 18789 },
          },
          { baseSnapshot, skipPluginValidation: true },
        ),
      ).resolves.toMatchObject({
        persistedConfig: {
          gateway: { mode: "local", port: 18789 },
          channels: { $include: "./config/channels.json5" },
        },
      });
    });
  });

  it("rejects stale runtime writes that resurrect removed channel scopes", async () => {
    await withSuiteHome(async (home) => {
      mockChannelPluginManifestRegistry("whatsapp");
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      const original = {
        meta: { lastTouchedVersion: "2026.5.17" },
        gateway: { mode: "local" },
        channels: {
          telegram: {
            enabled: true,
            accounts: {},
          },
        },
      } satisfies ConfigFileSnapshot["config"];
      const staleRuntime = {
        ...original,
        channels: {
          telegram: {
            enabled: true,
            accounts: {
              default: {
                enabled: true,
              },
            },
          },
          whatsapp: {
            enabled: true,
          },
        },
      } satisfies ConfigFileSnapshot["config"];
      const originalRaw = `${JSON.stringify(original, null, 2)}\n`;
      await fs.writeFile(configPath, originalRaw, "utf-8");
      const io = createConfigIO({
        env: { VITEST: "true" } as NodeJS.ProcessEnv,
        homedir: () => home,
        logger: silentLogger,
      });
      const baseSnapshot = {
        path: configPath,
        exists: true,
        raw: originalRaw,
        parsed: original,
        sourceConfig: original,
        resolved: original,
        valid: true,
        runtimeConfig: original,
        config: original,
        issues: [],
        warnings: [],
        legacyIssues: [],
      } satisfies ConfigFileSnapshot;

      await expect(io.writeConfigFile(staleRuntime, { baseSnapshot })).rejects.toMatchObject({
        code: "CONFIG_WRITE_REJECTED",
        reasons: expect.arrayContaining([
          "protected-channel-config-changed:channels.whatsapp",
          "protected-channel-config-changed:channels.telegram.accounts.default",
        ]),
      });
      await expect(
        io.writeConfigFile(staleRuntime, {
          baseSnapshot,
          explicitSetPaths: [["channels", "whatsapp", "sendReadReceipts"]],
        }),
      ).rejects.toMatchObject({
        code: "CONFIG_WRITE_REJECTED",
        reasons: expect.arrayContaining(["protected-channel-config-changed:channels.whatsapp"]),
      });
      await expect(
        io.writeConfigFile(staleRuntime, {
          baseSnapshot,
          explicitSetPaths: [["channels", "telegram", "accounts", "default", "authDir"]],
        }),
      ).rejects.toMatchObject({
        code: "CONFIG_WRITE_REJECTED",
        reasons: expect.arrayContaining([
          "protected-channel-config-changed:channels.telegram.accounts.default",
        ]),
      });
      await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(originalRaw);
    });
  });

  it("allows explicit parent channel edits to activate channel scopes", async () => {
    await withSuiteHome(async (home) => {
      mockChannelPluginManifestRegistry("whatsapp");
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      const original = {
        meta: { lastTouchedVersion: "2026.5.17" },
        gateway: { mode: "local" },
        channels: {
          telegram: {
            enabled: true,
            accounts: {},
          },
        },
      } satisfies ConfigFileSnapshot["config"];
      const originalRaw = `${JSON.stringify(original, null, 2)}\n`;
      await fs.writeFile(configPath, originalRaw, "utf-8");
      const io = createConfigIO({
        env: { VITEST: "true" } as NodeJS.ProcessEnv,
        homedir: () => home,
        logger: silentLogger,
      });
      const baseSnapshot = {
        path: configPath,
        exists: true,
        raw: originalRaw,
        parsed: original,
        sourceConfig: original,
        resolved: original,
        valid: true,
        runtimeConfig: original,
        config: original,
        issues: [],
        warnings: [],
        legacyIssues: [],
      } satisfies ConfigFileSnapshot;

      await expect(
        io.writeConfigFile(
          {
            ...original,
            channels: {
              ...original.channels,
              whatsapp: {},
            },
          },
          { baseSnapshot, explicitSetPaths: [["channels"]] },
        ),
      ).resolves.toMatchObject({
        persistedConfig: {
          channels: expect.objectContaining({ whatsapp: {} }),
        },
      });
      await fs.writeFile(configPath, originalRaw, "utf-8");
      await expect(
        io.writeConfigFile(
          {
            ...original,
            channels: {
              telegram: {
                enabled: true,
                accounts: {
                  default: {},
                },
              },
            },
          },
          { baseSnapshot, explicitSetPaths: [["channels", "telegram", "accounts"]] },
        ),
      ).resolves.toMatchObject({
        persistedConfig: {
          channels: {
            telegram: {
              accounts: { default: {} },
              enabled: true,
            },
          },
        },
      });
    });
  });

  it("rejects stale runtime writes that stage broad allowlists on disabled channel scopes", async () => {
    await withSuiteHome(async (home) => {
      mockChannelPluginManifestRegistry("whatsapp");
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      const original = {
        meta: { lastTouchedVersion: "2026.5.17" },
        gateway: { mode: "local" },
        channels: {},
      } satisfies ConfigFileSnapshot["config"];
      const staleRuntime = {
        ...original,
        channels: {
          whatsapp: {
            enabled: false,
            allowFrom: ["*"],
            accounts: {
              default: {
                enabled: false,
                allowFrom: ["*"],
              },
            },
          },
        },
      } satisfies ConfigFileSnapshot["config"];
      const originalRaw = `${JSON.stringify(original, null, 2)}\n`;
      await fs.writeFile(configPath, originalRaw, "utf-8");
      const io = createConfigIO({
        env: { VITEST: "true" } as NodeJS.ProcessEnv,
        homedir: () => home,
        logger: silentLogger,
      });
      const baseSnapshot = {
        path: configPath,
        exists: true,
        raw: originalRaw,
        parsed: original,
        sourceConfig: original,
        resolved: original,
        valid: true,
        runtimeConfig: original,
        config: original,
        issues: [],
        warnings: [],
        legacyIssues: [],
      } satisfies ConfigFileSnapshot;

      await expect(io.writeConfigFile(staleRuntime, { baseSnapshot })).rejects.toMatchObject({
        code: "CONFIG_WRITE_REJECTED",
        reasons: expect.arrayContaining([
          "protected-channel-config-changed:channels.whatsapp",
          "protected-channel-config-changed:channels.whatsapp.accounts.default",
        ]),
      });
      await expect(
        io.writeConfigFile(staleRuntime, {
          baseSnapshot,
          explicitSetPaths: [["channels", "whatsapp", "enabled"]],
        }),
      ).rejects.toMatchObject({
        code: "CONFIG_WRITE_REJECTED",
        reasons: expect.arrayContaining([
          "protected-channel-config-changed:channels.whatsapp",
          "protected-channel-config-changed:channels.whatsapp.accounts.default",
        ]),
      });
      await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(originalRaw);
    });
  });

  it("rejects stale runtime writes that remove enabled channel blocks without allowlists", async () => {
    await withSuiteHome(async (home) => {
      mockChannelPluginManifestRegistry("whatsapp");
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      const original = {
        meta: { lastTouchedVersion: "2026.5.17" },
        gateway: { mode: "local" },
        channels: {
          whatsapp: {
            enabled: true,
            sendReadReceipts: true,
          },
        },
      } satisfies ConfigFileSnapshot["config"];
      const staleRuntime = {
        ...original,
        channels: {},
      } satisfies ConfigFileSnapshot["config"];
      const originalRaw = `${JSON.stringify(original, null, 2)}\n`;
      await fs.writeFile(configPath, originalRaw, "utf-8");
      const io = createConfigIO({
        env: { VITEST: "true" } as NodeJS.ProcessEnv,
        homedir: () => home,
        logger: silentLogger,
      });
      const baseSnapshot = {
        path: configPath,
        exists: true,
        raw: originalRaw,
        parsed: original,
        sourceConfig: original,
        resolved: original,
        valid: true,
        runtimeConfig: original,
        config: original,
        issues: [],
        warnings: [],
        legacyIssues: [],
      } satisfies ConfigFileSnapshot;

      await expect(io.writeConfigFile(staleRuntime, { baseSnapshot })).rejects.toMatchObject({
        code: "CONFIG_WRITE_REJECTED",
        reasons: expect.arrayContaining(["protected-channel-config-changed:channels.whatsapp"]),
      });
      await expect(
        io.writeConfigFile(staleRuntime, {
          baseSnapshot,
          explicitSetPaths: [["channels", "whatsapp", "sendReadReceipts"]],
        }),
      ).rejects.toMatchObject({
        code: "CONFIG_WRITE_REJECTED",
        reasons: expect.arrayContaining(["protected-channel-config-changed:channels.whatsapp"]),
      });
      await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(originalRaw);
    });
  });

  it("rejects stale runtime writes that remove enabled channel accounts without allowlists", async () => {
    await withSuiteHome(async (home) => {
      mockChannelPluginManifestRegistry("whatsapp");
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      const original = {
        meta: { lastTouchedVersion: "2026.5.17" },
        gateway: { mode: "local" },
        channels: {
          whatsapp: {
            enabled: true,
            accounts: {
              work: {
                enabled: true,
                authDir: "/tmp/auth-work",
              },
            },
          },
        },
      } satisfies ConfigFileSnapshot["config"];
      const staleRuntime = {
        ...original,
        channels: {
          whatsapp: {
            enabled: true,
            accounts: {},
          },
        },
      } satisfies ConfigFileSnapshot["config"];
      const originalRaw = `${JSON.stringify(original, null, 2)}\n`;
      await fs.writeFile(configPath, originalRaw, "utf-8");
      const io = createConfigIO({
        env: { VITEST: "true" } as NodeJS.ProcessEnv,
        homedir: () => home,
        logger: silentLogger,
      });
      const baseSnapshot = {
        path: configPath,
        exists: true,
        raw: originalRaw,
        parsed: original,
        sourceConfig: original,
        resolved: original,
        valid: true,
        runtimeConfig: original,
        config: original,
        issues: [],
        warnings: [],
        legacyIssues: [],
      } satisfies ConfigFileSnapshot;

      await expect(io.writeConfigFile(staleRuntime, { baseSnapshot })).rejects.toMatchObject({
        code: "CONFIG_WRITE_REJECTED",
        reasons: expect.arrayContaining([
          "protected-channel-config-changed:channels.whatsapp.accounts.work",
        ]),
      });
      await expect(
        io.writeConfigFile(staleRuntime, {
          baseSnapshot,
          explicitSetPaths: [["channels", "whatsapp", "accounts", "work", "authDir"]],
        }),
      ).rejects.toMatchObject({
        code: "CONFIG_WRITE_REJECTED",
        reasons: expect.arrayContaining([
          "protected-channel-config-changed:channels.whatsapp.accounts.work",
        ]),
      });
      await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(originalRaw);
    });
  });

  it("rejects stale runtime writes that reintroduce channel allowlists", async () => {
    await withSuiteHome(async (home) => {
      mockChannelPluginManifestRegistry("discord");
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      const original = {
        meta: { lastTouchedVersion: "2026.5.17" },
        gateway: { mode: "local" },
        channels: {
          discord: {
            enabled: true,
            dm: {},
          },
        },
      } satisfies ConfigFileSnapshot["config"];
      const staleRuntime = {
        ...original,
        channels: {
          discord: {
            enabled: true,
            allowFrom: ["*"],
            dm: {
              allowFrom: ["*"],
            },
          },
        },
      } satisfies ConfigFileSnapshot["config"];
      const originalRaw = `${JSON.stringify(original, null, 2)}\n`;
      await fs.writeFile(configPath, originalRaw, "utf-8");
      const io = createConfigIO({
        env: { VITEST: "true" } as NodeJS.ProcessEnv,
        homedir: () => home,
        logger: silentLogger,
      });
      const baseSnapshot = {
        path: configPath,
        exists: true,
        raw: originalRaw,
        parsed: original,
        sourceConfig: original,
        resolved: original,
        valid: true,
        runtimeConfig: original,
        config: original,
        issues: [],
        warnings: [],
        legacyIssues: [],
      } satisfies ConfigFileSnapshot;

      await expect(io.writeConfigFile(staleRuntime, { baseSnapshot })).rejects.toMatchObject({
        code: "CONFIG_WRITE_REJECTED",
        reasons: expect.arrayContaining(["protected-channel-config-changed:channels.discord"]),
      });
      await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(originalRaw);
    });
  });

  it("rejects stale runtime writes that resurrect agents with elevated allowlists", async () => {
    await withSuiteHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      const original = {
        meta: { lastTouchedVersion: "2026.5.17" },
        gateway: { mode: "local" },
        agents: {
          list: [],
        },
      } satisfies ConfigFileSnapshot["config"];
      const staleRuntime = {
        ...original,
        agents: {
          list: [
            {
              id: "main",
              tools: {
                elevated: {
                  allowFrom: {
                    webchat: ["*"],
                  },
                },
              },
            },
          ],
        },
      } satisfies ConfigFileSnapshot["config"];
      const originalRaw = `${JSON.stringify(original, null, 2)}\n`;
      await fs.writeFile(configPath, originalRaw, "utf-8");
      const io = createConfigIO({
        env: { VITEST: "true" } as NodeJS.ProcessEnv,
        homedir: () => home,
        logger: silentLogger,
      });
      const baseSnapshot = {
        path: configPath,
        exists: true,
        raw: originalRaw,
        parsed: original,
        sourceConfig: original,
        resolved: original,
        valid: true,
        runtimeConfig: original,
        config: original,
        issues: [],
        warnings: [],
        legacyIssues: [],
      } satisfies ConfigFileSnapshot;

      await expect(io.writeConfigFile(staleRuntime, { baseSnapshot })).rejects.toMatchObject({
        code: "CONFIG_WRITE_REJECTED",
        reasons: expect.arrayContaining([
          "protected-agent-elevated-tools-changed:agents.list.main.tools.elevated.allowFrom",
        ]),
      });
      await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(originalRaw);
    });
  });

  it("does not treat global channels buckets as channel activation policy", async () => {
    await withSuiteHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      const original = {
        meta: { lastTouchedVersion: "2026.5.17" },
        gateway: { mode: "local" },
        channels: {
          defaults: {
            groupPolicy: "open",
          },
          modelByChannel: {
            telegram: {
              "123": "openai/gpt-5.4",
            },
          },
        },
      } as OpenClawConfig;
      const runtimeOriginal = original as ConfigFileSnapshot["config"];
      const next = {
        meta: original.meta,
        gateway: { mode: "local" },
        channels: {},
      } satisfies OpenClawConfig;
      const originalRaw = `${JSON.stringify(original, null, 2)}\n`;
      await fs.writeFile(configPath, originalRaw, "utf-8");
      const io = createConfigIO({
        env: { VITEST: "true" } as NodeJS.ProcessEnv,
        homedir: () => home,
        logger: silentLogger,
      });
      const baseSnapshot = {
        path: configPath,
        exists: true,
        raw: originalRaw,
        parsed: original,
        sourceConfig: original as ConfigFileSnapshot["sourceConfig"],
        resolved: original as ConfigFileSnapshot["resolved"],
        valid: true,
        runtimeConfig: runtimeOriginal,
        config: runtimeOriginal,
        issues: [],
        warnings: [],
        legacyIssues: [],
      } satisfies ConfigFileSnapshot;

      const result = await io.writeConfigFile(next, { baseSnapshot });

      expect(result.persistedConfig.channels).toEqual({});
    });
  });

  it("rejects stale runtime writes that change unrecognized channel policy fields", async () => {
    await withSuiteHome(async (home) => {
      mockChannelPluginManifestRegistry("futurechat");
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      const original = {
        meta: { lastTouchedVersion: "2026.5.17" },
        gateway: { mode: "local" },
        channels: {
          futurechat: {
            enabled: true,
            futurePolicy: {
              allowedTargets: ["session:trusted"],
            },
          },
        },
      } satisfies ConfigFileSnapshot["config"];
      const staleRuntime = {
        ...original,
        channels: {
          futurechat: {
            enabled: true,
            futurePolicy: {
              allowedTargets: ["*"],
            },
          },
        },
      } satisfies ConfigFileSnapshot["config"];
      const originalRaw = `${JSON.stringify(original, null, 2)}\n`;
      await fs.writeFile(configPath, originalRaw, "utf-8");
      const io = createConfigIO({
        env: { VITEST: "true" } as NodeJS.ProcessEnv,
        homedir: () => home,
        logger: silentLogger,
      });
      const baseSnapshot = {
        path: configPath,
        exists: true,
        raw: originalRaw,
        parsed: original,
        sourceConfig: original,
        resolved: original,
        valid: true,
        runtimeConfig: original,
        config: original,
        issues: [],
        warnings: [],
        legacyIssues: [],
      } satisfies ConfigFileSnapshot;

      await expect(
        io.writeConfigFile(staleRuntime, {
          baseSnapshot,
          explicitSetPaths: [["channels", "futurechat", "sendReadReceipts"]],
        }),
      ).rejects.toMatchObject({
        code: "CONFIG_WRITE_REJECTED",
        reasons: expect.arrayContaining(["protected-channel-config-changed:channels.futurechat"]),
      });
      await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(originalRaw);
    });
  });

  it("keeps env-authored protected policy writable for unrelated runtime edits", async () => {
    await withSuiteHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(
        configPath,
        `${JSON.stringify(
          {
            gateway: { mode: "local" },
            commands: {
              ownerAllowFrom: ["${OPENCLAW_TEST_OWNER_ALLOW}"],
            },
          },
          null,
          2,
        )}\n`,
        "utf-8",
      );
      const io = createConfigIO({
        env: {
          OPENCLAW_CONFIG_PATH: configPath,
          OPENCLAW_TEST_OWNER_ALLOW: "webchat:owner",
          VITEST: "true",
        } as NodeJS.ProcessEnv,
        homedir: () => home,
        logger: silentLogger,
      });
      const snapshot = await io.readConfigFileSnapshot();
      expect(snapshot.resolved.commands?.ownerAllowFrom).toEqual(["webchat:owner"]);

      const result = await io.writeConfigFile({
        ...snapshot.resolved,
        gateway: { mode: "local", port: 18789 },
      });

      expect(result.persistedConfig.gateway).toEqual({ mode: "local", port: 18789 });
      const persisted = JSON.parse(await fs.readFile(configPath, "utf-8")) as {
        commands?: { ownerAllowFrom?: string[] };
      };
      expect(persisted.commands?.ownerAllowFrom).toEqual(["${OPENCLAW_TEST_OWNER_ALLOW}"]);
    });
  });

  it("still rejects sibling protected allowlist drops during explicit bucket edits", async () => {
    await withSuiteHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      const original = {
        meta: { lastTouchedVersion: "2026.5.17" },
        gateway: { mode: "local" },
        tools: {
          elevated: {
            allowFrom: {
              webchat: ["session:trusted"],
              telegram: ["telegram:111"],
            },
          },
        },
      } satisfies ConfigFileSnapshot["config"];
      const staleRuntime = {
        ...original,
        tools: {
          elevated: {
            allowFrom: {
              webchat: ["session:trusted", "session:second"],
            },
          },
        },
      } satisfies ConfigFileSnapshot["config"];
      const originalRaw = `${JSON.stringify(original, null, 2)}\n`;
      await fs.writeFile(configPath, originalRaw, "utf-8");
      const io = createConfigIO({
        env: { VITEST: "true" } as NodeJS.ProcessEnv,
        homedir: () => home,
        logger: silentLogger,
      });
      const baseSnapshot = {
        path: configPath,
        exists: true,
        raw: originalRaw,
        parsed: original,
        sourceConfig: original,
        resolved: original,
        valid: true,
        runtimeConfig: original,
        config: original,
        issues: [],
        warnings: [],
        legacyIssues: [],
      } satisfies ConfigFileSnapshot;

      await expect(
        io.writeConfigFile(staleRuntime, {
          baseSnapshot,
          explicitSetPaths: [["tools", "elevated", "allowFrom", "webchat"]],
        }),
      ).rejects.toMatchObject({
        code: "CONFIG_WRITE_REJECTED",
        reasons: expect.arrayContaining([
          "protected-elevated-tools-changed:tools.elevated.allowFrom",
        ]),
      });
      await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(originalRaw);
    });
  });

  it("does not treat unrelated explicit agent list edits as protected policy edits", async () => {
    await withSuiteHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      const original = {
        meta: { lastTouchedVersion: "2026.5.17" },
        gateway: { mode: "local" },
        agents: {
          list: [
            {
              id: "main",
              model: "openai/gpt-5.4",
              tools: {
                elevated: {
                  allowFrom: {
                    webchat: ["session:trusted"],
                  },
                },
              },
            },
          ],
        },
      } satisfies ConfigFileSnapshot["config"];
      const staleRuntime = {
        ...original,
        agents: {
          list: [
            {
              id: "main",
              model: "openrouter/anthropic/claude-sonnet-4.6",
              tools: {
                elevated: {
                  allowFrom: {},
                },
              },
            },
          ],
        },
      } satisfies ConfigFileSnapshot["config"];
      const originalRaw = `${JSON.stringify(original, null, 2)}\n`;
      await fs.writeFile(configPath, originalRaw, "utf-8");
      const io = createConfigIO({
        env: { VITEST: "true" } as NodeJS.ProcessEnv,
        homedir: () => home,
        logger: silentLogger,
      });
      const baseSnapshot = {
        path: configPath,
        exists: true,
        raw: originalRaw,
        parsed: original,
        sourceConfig: original,
        resolved: original,
        valid: true,
        runtimeConfig: original,
        config: original,
        issues: [],
        warnings: [],
        legacyIssues: [],
      } satisfies ConfigFileSnapshot;

      await expect(
        io.writeConfigFile(staleRuntime, {
          baseSnapshot,
          explicitSetPaths: [["agents", "list", "0", "model"]],
        }),
      ).rejects.toMatchObject({
        code: "CONFIG_WRITE_REJECTED",
        reasons: expect.arrayContaining([
          "protected-agent-elevated-tools-changed:agents.list.main.tools.elevated.allowFrom",
        ]),
      });
      await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(originalRaw);
    });
  });

  it("allows explicit whole-agent edits to protected policy paths", async () => {
    await withSuiteHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      const original = {
        meta: { lastTouchedVersion: "2026.5.17" },
        gateway: { mode: "local" },
        agents: {
          list: [
            {
              id: "main",
              tools: {
                elevated: {
                  allowFrom: {
                    webchat: ["session:trusted"],
                  },
                },
              },
            },
          ],
        },
      } satisfies ConfigFileSnapshot["config"];
      const next = {
        meta: original.meta,
        gateway: { mode: "local" },
        agents: {
          list: [],
        },
      } satisfies ConfigFileSnapshot["config"];
      const originalRaw = `${JSON.stringify(original, null, 2)}\n`;
      await fs.writeFile(configPath, originalRaw, "utf-8");
      const io = createConfigIO({
        env: { VITEST: "true" } as NodeJS.ProcessEnv,
        homedir: () => home,
        logger: silentLogger,
      });
      const baseSnapshot = {
        path: configPath,
        exists: true,
        raw: originalRaw,
        parsed: original,
        sourceConfig: original,
        resolved: original,
        valid: true,
        runtimeConfig: original,
        config: original,
        issues: [],
        warnings: [],
        legacyIssues: [],
      } satisfies ConfigFileSnapshot;

      const result = await io.writeConfigFile(next, {
        baseSnapshot,
        explicitSetPaths: [["agents", "list", "0"]],
      });

      expect(result.persistedConfig.agents?.list).toEqual([]);
    });
  });

  it("rejects stale runtime writes that broaden protected allowlists without wildcards", async () => {
    await withSuiteHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      const original = {
        meta: { lastTouchedVersion: "2026.5.17" },
        gateway: { mode: "local" },
        commands: {
          ownerAllowFrom: ["webchat:owner"],
        },
      } satisfies ConfigFileSnapshot["config"];
      const staleRuntime = {
        ...original,
        commands: {
          ownerAllowFrom: ["webchat:owner", "telegram:111"],
        },
      } satisfies ConfigFileSnapshot["config"];
      const originalRaw = `${JSON.stringify(original, null, 2)}\n`;
      await fs.writeFile(configPath, originalRaw, "utf-8");
      const io = createConfigIO({
        env: { VITEST: "true" } as NodeJS.ProcessEnv,
        homedir: () => home,
        logger: silentLogger,
      });
      const baseSnapshot = {
        path: configPath,
        exists: true,
        raw: originalRaw,
        parsed: original,
        sourceConfig: original,
        resolved: original,
        valid: true,
        runtimeConfig: original,
        config: original,
        issues: [],
        warnings: [],
        legacyIssues: [],
      } satisfies ConfigFileSnapshot;

      await expect(io.writeConfigFile(staleRuntime, { baseSnapshot })).rejects.toMatchObject({
        code: "CONFIG_WRITE_REJECTED",
        reasons: expect.arrayContaining(["protected-command-policy-changed:commands.ownerAllowFrom"]),
      });
      await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(originalRaw);
    });
  });

  it("rejects stale runtime writes that resurrect removed protected allowlist map entries", async () => {
    await withSuiteHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      const original = {
        meta: { lastTouchedVersion: "2026.5.17" },
        gateway: { mode: "local" },
        tools: {
          elevated: {
            allowFrom: {
              webchat: ["session:trusted"],
            },
          },
        },
      } satisfies ConfigFileSnapshot["config"];
      const staleRuntime = {
        ...original,
        tools: {
          elevated: {
            allowFrom: {
              webchat: ["session:trusted"],
              telegram: ["telegram:111"],
            },
          },
        },
      } satisfies ConfigFileSnapshot["config"];
      const originalRaw = `${JSON.stringify(original, null, 2)}\n`;
      await fs.writeFile(configPath, originalRaw, "utf-8");
      const io = createConfigIO({
        env: { VITEST: "true" } as NodeJS.ProcessEnv,
        homedir: () => home,
        logger: silentLogger,
      });
      const baseSnapshot = {
        path: configPath,
        exists: true,
        raw: originalRaw,
        parsed: original,
        sourceConfig: original,
        resolved: original,
        valid: true,
        runtimeConfig: original,
        config: original,
        issues: [],
        warnings: [],
        legacyIssues: [],
      } satisfies ConfigFileSnapshot;

      await expect(io.writeConfigFile(staleRuntime, { baseSnapshot })).rejects.toMatchObject({
        code: "CONFIG_WRITE_REJECTED",
        reasons: expect.arrayContaining([
          "protected-elevated-tools-changed:tools.elevated.allowFrom",
        ]),
      });
      await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(originalRaw);
    });
  });

  it("rejects stale runtime writes that resurrect removed protected policy blocks", async () => {
    await withSuiteHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      const original = {
        meta: { lastTouchedVersion: "2026.5.17" },
        gateway: { mode: "local" },
      } satisfies ConfigFileSnapshot["config"];
      const staleRuntime = {
        ...original,
        commands: {
          ownerAllowFrom: ["webchat:owner"],
        },
        tools: {
          elevated: {
            allowFrom: {
              telegram: ["telegram:111"],
            },
          },
        },
      } satisfies ConfigFileSnapshot["config"];
      const originalRaw = `${JSON.stringify(original, null, 2)}\n`;
      await fs.writeFile(configPath, originalRaw, "utf-8");
      const io = createConfigIO({
        env: { VITEST: "true" } as NodeJS.ProcessEnv,
        homedir: () => home,
        logger: silentLogger,
      });
      const baseSnapshot = {
        path: configPath,
        exists: true,
        raw: originalRaw,
        parsed: original,
        sourceConfig: original,
        resolved: original,
        valid: true,
        runtimeConfig: original,
        config: original,
        issues: [],
        warnings: [],
        legacyIssues: [],
      } satisfies ConfigFileSnapshot;

      await expect(io.writeConfigFile(staleRuntime, { baseSnapshot })).rejects.toMatchObject({
        code: "CONFIG_WRITE_REJECTED",
        reasons: expect.arrayContaining([
          "protected-command-policy-changed:commands.ownerAllowFrom",
          "protected-elevated-tools-changed:tools.elevated.allowFrom",
        ]),
      });
      await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(originalRaw);
    });
  });

  it("rejects stale runtime writes that re-open empty protected allowlists", async () => {
    await withSuiteHome(async (home) => {
      mockChannelPluginManifestRegistry("whatsapp");
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      const original = {
        meta: { lastTouchedVersion: "2026.5.17" },
        gateway: { mode: "local" },
        commands: {
          ownerAllowFrom: [],
        },
        channels: {
          whatsapp: {
            allowFrom: [],
          },
        },
      } satisfies ConfigFileSnapshot["config"];
      const staleRuntime = {
        ...original,
        commands: {
          ownerAllowFrom: ["webchat:owner"],
        },
        channels: {
          whatsapp: {
            allowFrom: ["*"],
          },
        },
      } satisfies ConfigFileSnapshot["config"];
      const originalRaw = `${JSON.stringify(original, null, 2)}\n`;
      await fs.writeFile(configPath, originalRaw, "utf-8");
      const io = createConfigIO({
        env: { VITEST: "true" } as NodeJS.ProcessEnv,
        homedir: () => home,
        logger: silentLogger,
      });
      const baseSnapshot = {
        path: configPath,
        exists: true,
        raw: originalRaw,
        parsed: original,
        sourceConfig: original,
        resolved: original,
        valid: true,
        runtimeConfig: original,
        config: original,
        issues: [],
        warnings: [],
        legacyIssues: [],
      } satisfies ConfigFileSnapshot;

      await expect(io.writeConfigFile(staleRuntime, { baseSnapshot })).rejects.toMatchObject({
        code: "CONFIG_WRITE_REJECTED",
        reasons: expect.arrayContaining([
          "protected-command-policy-changed:commands.ownerAllowFrom",
          "protected-channel-config-changed:channels.whatsapp",
        ]),
      });
      await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(originalRaw);
    });
  });

  it("rejects stale runtime writes that drop nested channel allowlists", async () => {
    await withSuiteHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      const original = {
        meta: { lastTouchedVersion: "2026.5.17" },
        gateway: { mode: "local" },
        channels: {
          googlechat: {
            dm: { allowFrom: ["space:trusted"] },
            groups: {
              ops: {
                users: ["users/trusted"],
              },
            },
          },
          discord: {
            guilds: {
              main: {
                users: ["user:trusted"],
                channels: {
                  alerts: {
                    roles: ["role:trusted"],
                  },
                },
              },
            },
          },
          matrix: {
            accounts: {
              ops: {
                dm: { allowFrom: ["@trusted:example.org"] },
                execApprovals: { approvers: ["@owner:example.org"] },
              },
            },
          },
        },
      } satisfies ConfigFileSnapshot["config"];
      const staleRuntime = {
        ...original,
        channels: {
          googlechat: {
            dm: {},
            groups: {
              ops: {
                users: ["users/trusted", "users/stale"],
              },
            },
          },
          discord: {
            guilds: {
              main: {
                users: [],
                channels: {
                  alerts: {
                    roles: ["role:trusted", "role:stale"],
                  },
                },
              },
            },
          },
          matrix: {
            accounts: {
              ops: {
                dm: { allowFrom: ["@trusted:example.org", "@stale:example.org"] },
                execApprovals: { approvers: [] },
              },
            },
          },
        },
      } satisfies ConfigFileSnapshot["config"];
      const originalRaw = `${JSON.stringify(original, null, 2)}\n`;
      await fs.writeFile(configPath, originalRaw, "utf-8");
      const io = createConfigIO({
        env: { VITEST: "true" } as NodeJS.ProcessEnv,
        homedir: () => home,
        logger: silentLogger,
      });
      const baseSnapshot = {
        path: configPath,
        exists: true,
        raw: originalRaw,
        parsed: original,
        sourceConfig: original,
        resolved: original,
        valid: true,
        runtimeConfig: original,
        config: original,
        issues: [],
        warnings: [],
        legacyIssues: [],
      } satisfies ConfigFileSnapshot;

      await expect(io.writeConfigFile(staleRuntime, { baseSnapshot })).rejects.toMatchObject({
        code: "CONFIG_WRITE_REJECTED",
        reasons: expect.arrayContaining([
          "protected-channel-config-changed:channels.googlechat",
          "protected-channel-config-changed:channels.discord",
          "protected-channel-config-changed:channels.matrix.accounts.ops",
        ]),
      });
      await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(originalRaw);
    });
  });

  it("allows explicit config edits to protected policy paths", async () => {
    await withSuiteHome(async (home) => {
      mockChannelPluginManifestRegistry("whatsapp");
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      const original = {
        meta: { lastTouchedVersion: "2026.5.17" },
        gateway: { mode: "local" },
        channels: {
          whatsapp: {
            enabled: true,
            allowFrom: ["+15550001111", "+15550002222"],
          },
        },
      } satisfies ConfigFileSnapshot["config"];
      const next = {
        meta: original.meta,
        gateway: { mode: "local" },
        channels: {
          whatsapp: {
            enabled: true,
            allowFrom: ["+15550001111"],
          },
        },
      } satisfies ConfigFileSnapshot["config"];
      const originalRaw = `${JSON.stringify(original, null, 2)}\n`;
      await fs.writeFile(configPath, originalRaw, "utf-8");
      const io = createConfigIO({
        env: { VITEST: "true" } as NodeJS.ProcessEnv,
        homedir: () => home,
        logger: silentLogger,
      });
      const baseSnapshot = {
        path: configPath,
        exists: true,
        raw: originalRaw,
        parsed: original,
        sourceConfig: original,
        resolved: original,
        valid: true,
        runtimeConfig: original,
        config: original,
        issues: [],
        warnings: [],
        legacyIssues: [],
      } satisfies ConfigFileSnapshot;

      const result = await io.writeConfigFile(next, {
        baseSnapshot,
        explicitSetPaths: [["channels", "whatsapp", "allowFrom"]],
      });

      expect(result.persistedConfig.channels?.whatsapp?.allowFrom).toEqual(["+15550001111"]);
    });
  });

  it("allows explicit indexed edits to protected policy arrays", async () => {
    await withSuiteHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      const original = {
        meta: { lastTouchedVersion: "2026.5.17" },
        gateway: { mode: "local" },
        commands: {
          ownerAllowFrom: ["webchat:owner", "telegram:111"],
        },
      } satisfies ConfigFileSnapshot["config"];
      const next = {
        meta: original.meta,
        gateway: { mode: "local" },
        commands: {
          ownerAllowFrom: ["telegram:111"],
        },
      } satisfies ConfigFileSnapshot["config"];
      const originalRaw = `${JSON.stringify(original, null, 2)}\n`;
      await fs.writeFile(configPath, originalRaw, "utf-8");
      const io = createConfigIO({
        env: { VITEST: "true" } as NodeJS.ProcessEnv,
        homedir: () => home,
        logger: silentLogger,
      });
      const baseSnapshot = {
        path: configPath,
        exists: true,
        raw: originalRaw,
        parsed: original,
        sourceConfig: original,
        resolved: original,
        valid: true,
        runtimeConfig: original,
        config: original,
        issues: [],
        warnings: [],
        legacyIssues: [],
      } satisfies ConfigFileSnapshot;

      const result = await io.writeConfigFile(next, {
        baseSnapshot,
        explicitSetPaths: [["commands", "ownerAllowFrom", "0"]],
      });

      expect(result.persistedConfig.commands?.ownerAllowFrom).toEqual(["telegram:111"]);
    });
  });

  it("allows non-policy command settings without protected-policy exemptions", async () => {
    await withSuiteHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      const original = {
        meta: { lastTouchedVersion: "2026.5.17" },
        gateway: { mode: "local" },
        commands: {
          text: true,
          ownerAllowFrom: ["webchat:owner"],
        },
      } satisfies ConfigFileSnapshot["config"];
      const next = {
        meta: original.meta,
        gateway: { mode: "local" },
        commands: {
          text: false,
          ownerAllowFrom: ["webchat:owner"],
        },
      } satisfies ConfigFileSnapshot["config"];
      const originalRaw = `${JSON.stringify(original, null, 2)}\n`;
      await fs.writeFile(configPath, originalRaw, "utf-8");
      const io = createConfigIO({
        env: { VITEST: "true" } as NodeJS.ProcessEnv,
        homedir: () => home,
        logger: silentLogger,
      });
      const baseSnapshot = {
        path: configPath,
        exists: true,
        raw: originalRaw,
        parsed: original,
        sourceConfig: original,
        resolved: original,
        valid: true,
        runtimeConfig: original,
        config: original,
        issues: [],
        warnings: [],
        legacyIssues: [],
      } satisfies ConfigFileSnapshot;

      const result = await io.writeConfigFile(next, { baseSnapshot });

      expect(result.persistedConfig.commands?.text).toBe(false);
      expect(result.persistedConfig.commands?.ownerAllowFrom).toEqual(["webchat:owner"]);
    });
  });

  it("allows non-explicit writes that materialize empty protected-policy containers", async () => {
    await withSuiteHome(async (home) => {
      mockChannelPluginManifestRegistry("whatsapp");
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      const original = {
        meta: { lastTouchedVersion: "2026.5.17" },
        gateway: { mode: "local" },
      } satisfies ConfigFileSnapshot["config"];
      const next = {
        meta: original.meta,
        gateway: { mode: "local" },
        commands: {
          ownerAllowFrom: [],
        },
        tools: {
          elevated: {
            allowFrom: {},
          },
        },
        agents: {
          list: [
            {
              id: "main",
              tools: {
                elevated: {
                  allowFrom: {},
                },
              },
            },
          ],
        },
        channels: {
          whatsapp: {
            accounts: {
              default: {},
            },
          },
        },
      } satisfies ConfigFileSnapshot["config"];
      const originalRaw = `${JSON.stringify(original, null, 2)}\n`;
      await fs.writeFile(configPath, originalRaw, "utf-8");
      const io = createConfigIO({
        env: { VITEST: "true" } as NodeJS.ProcessEnv,
        homedir: () => home,
        logger: silentLogger,
      });
      const baseSnapshot = {
        path: configPath,
        exists: true,
        raw: originalRaw,
        parsed: original,
        sourceConfig: original,
        resolved: original,
        valid: true,
        runtimeConfig: original,
        config: original,
        issues: [],
        warnings: [],
        legacyIssues: [],
      } satisfies ConfigFileSnapshot;

      await expect(io.writeConfigFile(next, { baseSnapshot })).resolves.toMatchObject({
        persistedConfig: {
          commands: { ownerAllowFrom: [] },
          tools: { elevated: { allowFrom: {} } },
        },
      });
    });
  });

  it("allows explicit config unsets to protected policy paths", async () => {
    await withSuiteHome(async (home) => {
      mockChannelPluginManifestRegistry("whatsapp");
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      const original = {
        meta: { lastTouchedVersion: "2026.5.17" },
        gateway: { mode: "local" },
        channels: {
          whatsapp: {
            enabled: true,
            allowFrom: ["+15550001111"],
          },
        },
      } satisfies ConfigFileSnapshot["config"];
      const next = {
        meta: original.meta,
        gateway: { mode: "local" },
        channels: {
          whatsapp: {
            enabled: true,
          },
        },
      } satisfies ConfigFileSnapshot["config"];
      const originalRaw = `${JSON.stringify(original, null, 2)}\n`;
      await fs.writeFile(configPath, originalRaw, "utf-8");
      const io = createConfigIO({
        env: { VITEST: "true" } as NodeJS.ProcessEnv,
        homedir: () => home,
        logger: silentLogger,
      });
      const baseSnapshot = {
        path: configPath,
        exists: true,
        raw: originalRaw,
        parsed: original,
        sourceConfig: original,
        resolved: original,
        valid: true,
        runtimeConfig: original,
        config: original,
        issues: [],
        warnings: [],
        legacyIssues: [],
      } satisfies ConfigFileSnapshot;

      const result = await io.writeConfigFile(next, {
        baseSnapshot,
        unsetPaths: [["channels", "whatsapp", "allowFrom"]],
      });

      expect(result.persistedConfig.channels?.whatsapp?.allowFrom).toBeUndefined();
    });
  });

  it("allows explicit unsets that remove the final protected allowFrom map entry", async () => {
    await withSuiteHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      const original = {
        meta: { lastTouchedVersion: "2026.5.17" },
        gateway: { mode: "local" },
        tools: {
          elevated: {
            allowFrom: {
              webchat: ["session:trusted"],
            },
          },
        },
      } satisfies ConfigFileSnapshot["config"];
      const next = {
        meta: original.meta,
        gateway: { mode: "local" },
        tools: {
          elevated: {},
        },
      } satisfies ConfigFileSnapshot["config"];
      const originalRaw = `${JSON.stringify(original, null, 2)}\n`;
      await fs.writeFile(configPath, originalRaw, "utf-8");
      const io = createConfigIO({
        env: { VITEST: "true" } as NodeJS.ProcessEnv,
        homedir: () => home,
        logger: silentLogger,
      });
      const baseSnapshot = {
        path: configPath,
        exists: true,
        raw: originalRaw,
        parsed: original,
        sourceConfig: original,
        resolved: original,
        valid: true,
        runtimeConfig: original,
        config: original,
        issues: [],
        warnings: [],
        legacyIssues: [],
      } satisfies ConfigFileSnapshot;

      const result = await io.writeConfigFile(next, {
        baseSnapshot,
        unsetPaths: [["tools", "elevated", "allowFrom", "webchat"]],
      });

      expect(result.persistedConfig.tools?.elevated?.allowFrom).toBeUndefined();
    });
  });

  it("keeps authored agent provider params during narrowed internal agent writes", async () => {
    await withSuiteHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      const original = {
        gateway: { mode: "local" },
        agents: {
          defaults: {
            params: { transport: "sse", openaiWsWarmup: false },
            models: {
              "openai/gpt-5.4": {
                alias: "GPT",
                params: { transport: "sse", openaiWsWarmup: false },
              },
            },
          },
          list: [{ id: "main" }],
        },
      } satisfies ConfigFileSnapshot["sourceConfig"];
      const originalRaw = `${JSON.stringify(original, null, 2)}\n`;
      await fs.writeFile(configPath, originalRaw, "utf-8");
      const io = createConfigIO({
        env: { VITEST: "true" } as NodeJS.ProcessEnv,
        homedir: () => home,
        logger: silentLogger,
      });
      const baseSnapshot = {
        path: configPath,
        exists: true,
        raw: originalRaw,
        parsed: original,
        sourceConfig: original,
        resolved: original,
        valid: true,
        runtimeConfig: {
          ...original,
          agents: {
            ...original.agents,
            defaults: {
              ...original.agents.defaults,
              maxConcurrent: 4,
            },
          },
        },
        config: {
          ...original,
          agents: {
            ...original.agents,
            defaults: {
              ...original.agents.defaults,
              maxConcurrent: 4,
            },
          },
        },
        issues: [],
        warnings: [],
        legacyIssues: [],
      } satisfies ConfigFileSnapshot;

      await io.writeConfigFile(
        {
          gateway: { mode: "local" },
          agents: { list: [{ id: "main" }, { id: "ops" }] },
        },
        { baseSnapshot },
      );

      const persisted = JSON.parse(await fs.readFile(configPath, "utf-8")) as OpenClawConfig;
      expect(persisted.agents?.defaults?.params).toEqual({
        transport: "sse",
        openaiWsWarmup: false,
      });
      expect(persisted.agents?.defaults?.models?.["openai/gpt-5.4"]).toEqual({
        alias: "GPT",
        params: { transport: "sse", openaiWsWarmup: false },
      });
      expect(persisted.agents?.list).toEqual([{ id: "main" }, { id: "ops" }]);
    });
  });

  it("preserves parsed source config when snapshot validation fails", async () => {
    await withSuiteHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      const original = {
        gateway: { mode: "local" },
        channels: { "test-plugin-channel": { enabled: true } },
      };
      const originalRaw = `${JSON.stringify(original, null, 2)}\n`;
      await fs.writeFile(configPath, originalRaw, "utf-8");
      const io = createFastConfigIO(home);

      const snapshot = await io.readConfigFileSnapshot();

      expect(snapshot.valid).toBe(false);
      expect(snapshot.raw).toBe(originalRaw);
      expect(snapshot.parsed).toEqual(original);
      expect(snapshot.sourceConfig).toEqual(original);
      expect(snapshot.config).toEqual(original);
      expect(snapshot.issues[0]?.message).toContain("unknown channel id: test-plugin-channel");
    });
  });

  it("rejects root-include partial writes instead of flattening the root config", async () => {
    await withSuiteHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      const includePath = path.join(home, ".openclaw", "extra.json5");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(
        includePath,
        `${JSON.stringify({ $schema: "https://openclaw.ai/config-from-include.json" }, null, 2)}\n`,
        "utf-8",
      );
      await fs.writeFile(
        configPath,
        `{\n  "$include": "./extra.json5",\n  "gateway": { "mode": "local" }\n}\n`,
        "utf-8",
      );
      const originalRaw = await fs.readFile(configPath, "utf-8");

      await expect(writeGatewayPortAndReadConfig(home, configPath)).rejects.toThrow(
        "Config write would flatten $include-owned config at <root>",
      );
      await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(originalRaw);
    });
  });

  it("writes disabled plugin entries without requiring plugin config", async () => {
    mockLoadPluginManifestRegistry.mockReturnValue({
      diagnostics: [],
      plugins: [
        {
          id: "required-plugin",
          origin: "bundled",
          channels: [],
          providers: [],
          cliBackends: [],
          skills: [],
          hooks: [],
          rootDir: "/tmp/openclaw-test-required-plugin",
          source: "/tmp/openclaw-test-required-plugin/index.ts",
          manifestPath: "/tmp/openclaw-test-required-plugin/openclaw.plugin.json",
          configSchema: {
            type: "object",
            properties: {
              token: { type: "string" },
            },
            required: ["token"],
            additionalProperties: true,
          },
        },
      ],
    } satisfies PluginManifestRegistry);

    await withSuiteHome(async (home) => {
      const io = createConfigIO({
        env: { VITEST: "true" } as NodeJS.ProcessEnv,
        homedir: () => home,
        logger: silentLogger,
      });

      expectPersistedHashResult(
        await io.writeConfigFile({
          agents: { list: [{ id: "main", default: true }] },
          plugins: {
            entries: {
              "required-plugin": {
                enabled: false,
              },
            },
          },
        }),
      );
    });

    mockLoadPluginManifestRegistry.mockReturnValue({
      diagnostics: [],
      plugins: [],
    } satisfies PluginManifestRegistry);
  });

  it("writes runtime-derived edits back to source SecretRef markers", async () => {
    await withSuiteHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      const previousConfigPath = process.env.OPENCLAW_CONFIG_PATH;
      process.env.OPENCLAW_CONFIG_PATH = configPath;
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(
        configPath,
        `${JSON.stringify(
          {
            gateway: { mode: "local" },
            models: {
              providers: {
                openai: {
                  baseUrl: "https://api.openai.com/v1",
                  apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
                  models: [],
                },
              },
            },
          },
          null,
          2,
        )}\n`,
        "utf-8",
      );

      try {
        setRuntimeConfigSnapshot(
          {
            gateway: { mode: "local" },
            models: {
              providers: {
                openai: {
                  baseUrl: "https://api.openai.com/v1",
                  apiKey: "sk-runtime-resolved",
                  models: [],
                },
              },
            },
          },
          {
            gateway: { mode: "local" },
            models: {
              providers: {
                openai: {
                  baseUrl: "https://api.openai.com/v1",
                  apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
                  models: [],
                },
              },
            },
          },
        );

        await writeConfigFile({
          gateway: { mode: "local", port: 18789 },
          models: {
            providers: {
              openai: {
                baseUrl: "https://api.openai.com/v1",
                apiKey: "sk-runtime-resolved",
                models: [],
              },
            },
          },
        });

        const persisted = JSON.parse(await fs.readFile(configPath, "utf-8")) as {
          meta?: Record<string, unknown>;
        };
        expect(persisted).toEqual({
          gateway: { mode: "local", port: 18789 },
          models: {
            providers: {
              openai: {
                baseUrl: "https://api.openai.com/v1",
                apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
                models: [],
              },
            },
          },
          meta: {
            lastTouchedAt: persisted.meta?.lastTouchedAt,
            lastTouchedVersion: persisted.meta?.lastTouchedVersion,
          },
        });
        expect(typeof persisted.meta?.lastTouchedAt).toBe("string");
        expect(typeof persisted.meta?.lastTouchedVersion).toBe("string");
      } finally {
        if (previousConfigPath === undefined) {
          delete process.env.OPENCLAW_CONFIG_PATH;
        } else {
          process.env.OPENCLAW_CONFIG_PATH = previousConfigPath;
        }
      }
    });
  });

  it("notifies in-process reloaders with resolved source config when persisted env refs are restored", async () => {
    await withSuiteHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      const previousConfigPath = process.env.OPENCLAW_CONFIG_PATH;
      const previousGatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN;
      process.env.OPENCLAW_CONFIG_PATH = configPath;
      process.env.OPENCLAW_GATEWAY_TOKEN = "gateway-token-runtime";
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(
        configPath,
        `${JSON.stringify(
          {
            gateway: {
              mode: "local",
              auth: { mode: "token", token: "${OPENCLAW_GATEWAY_TOKEN}" },
            },
            agents: { defaults: { model: { primary: "openai/gpt-5.4" } } },
          },
          null,
          2,
        )}\n`,
        "utf-8",
      );
      const observedSources: unknown[] = [];
      const unsubscribe = registerConfigWriteListener((event) => {
        observedSources.push(event.sourceConfig);
      });

      try {
        setRuntimeConfigSnapshot(
          {
            gateway: {
              mode: "local",
              auth: { mode: "token", token: "gateway-token-runtime" },
            },
            agents: { defaults: { model: { primary: "openai/gpt-5.4" } } },
          },
          {
            gateway: {
              mode: "local",
              auth: { mode: "token", token: "gateway-token-runtime" },
            },
            agents: { defaults: { model: { primary: "openai/gpt-5.4" } } },
          },
        );

        await writeConfigFile({
          gateway: {
            mode: "local",
            auth: { mode: "token", token: "gateway-token-runtime" },
          },
          agents: { defaults: { model: { primary: "openrouter/anthropic/claude-sonnet-4.6" } } },
        });

        const persisted = JSON.parse(await fs.readFile(configPath, "utf-8")) as {
          gateway?: { auth?: { token?: string } };
        };
        expect(persisted.gateway?.auth?.token).toBe("${OPENCLAW_GATEWAY_TOKEN}");
        expect(observedSources).toHaveLength(1);
        const observedSource = requireRecord(observedSources[0], "observed source config");
        expect(observedSource.gateway).toEqual({
          mode: "local",
          auth: { mode: "token", token: "gateway-token-runtime" },
        });
        expect(observedSource.agents).toEqual({
          defaults: {
            model: { primary: "openrouter/anthropic/claude-sonnet-4.6" },
          },
        });
      } finally {
        unsubscribe();
        if (previousConfigPath === undefined) {
          delete process.env.OPENCLAW_CONFIG_PATH;
        } else {
          process.env.OPENCLAW_CONFIG_PATH = previousConfigPath;
        }
        if (previousGatewayToken === undefined) {
          delete process.env.OPENCLAW_GATEWAY_TOKEN;
        } else {
          process.env.OPENCLAW_GATEWAY_TOKEN = previousGatewayToken;
        }
      }
    });
  });

  it("notifies in-process reloaders with canonical post-write source config", async () => {
    mockLoadPluginManifestRegistry.mockReturnValue({
      diagnostics: [],
      plugins: [
        {
          id: "demo",
          origin: "bundled",
          channels: [],
          providers: [],
          cliBackends: [],
          skills: [],
          hooks: [],
          rootDir: "/tmp/openclaw-test-demo",
          source: "/tmp/openclaw-test-demo/index.ts",
          manifestPath: "/tmp/openclaw-test-demo/openclaw.plugin.json",
          configSchema: {
            type: "object",
            properties: {
              mode: { type: "string", default: "auto" },
            },
            additionalProperties: true,
          },
        },
      ],
    } satisfies PluginManifestRegistry);

    await withSuiteHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      const previousConfigPath = process.env.OPENCLAW_CONFIG_PATH;
      process.env.OPENCLAW_CONFIG_PATH = configPath;
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      const sourceConfig = {
        gateway: { mode: "local" },
        agents: { defaults: { model: { primary: "openai/gpt-5.4" } } },
        plugins: { entries: { demo: { enabled: true, config: {} } } },
      } satisfies ConfigFileSnapshot["sourceConfig"];
      await fs.writeFile(configPath, `${JSON.stringify(sourceConfig, null, 2)}\n`, "utf-8");
      const runtimeConfig = {
        ...structuredClone(sourceConfig),
        plugins: {
          entries: {
            demo: { enabled: true, config: { mode: "auto" } },
          },
        },
      } satisfies ConfigFileSnapshot["config"];
      const observedSources: unknown[] = [];
      const unsubscribe = registerConfigWriteListener((event) => {
        observedSources.push(event.sourceConfig);
      });

      try {
        setRuntimeConfigSnapshot(runtimeConfig, sourceConfig);

        await writeConfigFile({
          ...runtimeConfig,
          agents: {
            defaults: {
              model: { primary: "openrouter/anthropic/claude-sonnet-4.6" },
            },
          },
        });

        const postWriteSnapshot = await createConfigIO({
          env: { OPENCLAW_CONFIG_PATH: configPath, VITEST: "true" } as NodeJS.ProcessEnv,
          homedir: () => home,
          logger: silentLogger,
        }).readConfigFileSnapshot();

        expect(postWriteSnapshot.valid).toBe(true);
        expect(observedSources).toEqual([postWriteSnapshot.sourceConfig]);
        expect(getRuntimeConfigSourceSnapshot()).toEqual(postWriteSnapshot.sourceConfig);
        expect(postWriteSnapshot.sourceConfig.meta?.lastTouchedAt).toMatch(
          /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u,
        );
        expect(postWriteSnapshot.sourceConfig.plugins?.entries?.demo?.config).toStrictEqual({});
      } finally {
        unsubscribe();
        mockLoadPluginManifestRegistry.mockReturnValue({
          diagnostics: [],
          plugins: [],
        } satisfies PluginManifestRegistry);
        if (previousConfigPath === undefined) {
          delete process.env.OPENCLAW_CONFIG_PATH;
        } else {
          process.env.OPENCLAW_CONFIG_PATH = previousConfigPath;
        }
      }
    });
  });

  it("persists explicit default-valued paths through the exported write wrapper", async () => {
    mockLoadPluginManifestRegistry.mockReturnValue({
      diagnostics: [],
      plugins: [
        {
          id: "demo",
          origin: "bundled",
          channels: [],
          providers: [],
          cliBackends: [],
          skills: [],
          hooks: [],
          rootDir: "/tmp/openclaw-test-demo",
          source: "/tmp/openclaw-test-demo/index.ts",
          manifestPath: "/tmp/openclaw-test-demo/openclaw.plugin.json",
          configSchema: {
            type: "object",
            properties: {
              mode: { type: "string", default: "auto" },
            },
            additionalProperties: true,
          },
        },
      ],
    } satisfies PluginManifestRegistry);

    await withSuiteHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      const previousConfigPath = process.env.OPENCLAW_CONFIG_PATH;
      process.env.OPENCLAW_CONFIG_PATH = configPath;
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      const sourceConfig = {
        gateway: { mode: "local" },
        plugins: { entries: { demo: { enabled: true, config: {} } } },
      } satisfies ConfigFileSnapshot["sourceConfig"];
      await fs.writeFile(configPath, `${JSON.stringify(sourceConfig, null, 2)}\n`, "utf-8");
      const runtimeConfig = {
        ...structuredClone(sourceConfig),
        plugins: {
          entries: {
            demo: { enabled: true, config: { mode: "auto" } },
          },
        },
      } satisfies ConfigFileSnapshot["config"];

      try {
        setRuntimeConfigSnapshot(runtimeConfig, sourceConfig);

        await writeConfigFile(runtimeConfig, {
          explicitSetPaths: [["plugins", "entries", "demo", "config"]],
        });

        const persisted = JSON.parse(await fs.readFile(configPath, "utf-8")) as OpenClawConfig;
        expect(persisted.plugins?.entries?.demo?.config).toStrictEqual({ mode: "auto" });
      } finally {
        mockLoadPluginManifestRegistry.mockReturnValue({
          diagnostics: [],
          plugins: [],
        } satisfies PluginManifestRegistry);
        if (previousConfigPath === undefined) {
          delete process.env.OPENCLAW_CONFIG_PATH;
        } else {
          process.env.OPENCLAW_CONFIG_PATH = previousConfigPath;
        }
      }
    });
  });

  it("skipPluginValidation bypasses plugin schema rejection on writeConfigFile (#76800)", async () => {
    await withSuiteHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      const previousConfigPath = process.env.OPENCLAW_CONFIG_PATH;
      process.env.OPENCLAW_CONFIG_PATH = configPath;
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(configPath, "{}\n", "utf-8");
      mockLoadPluginManifestRegistry.mockReturnValue({
        diagnostics: [],
        plugins: [
          {
            id: "strict-plugin",
            origin: "bundled",
            channels: [],
            providers: [],
            cliBackends: [],
            skills: [],
            hooks: [],
            rootDir: "/tmp/openclaw-test-strict-plugin",
            source: "/tmp/openclaw-test-strict-plugin/index.ts",
            manifestPath: "/tmp/openclaw-test-strict-plugin/openclaw.plugin.json",
            configSchema: {
              type: "object",
              properties: { token: { type: "string" } },
              required: ["token"],
              additionalProperties: false,
            },
          },
        ],
      } satisfies PluginManifestRegistry);

      try {
        // Plugin is enabled but missing required "token" — validation fails without skip.
        const cfg: OpenClawConfig = {
          agents: { list: [{ id: "main", default: true }] },
          plugins: { entries: { "strict-plugin": { enabled: true } } },
        };

        await writeConfigFile(cfg, { skipPluginValidation: true });
        await expect(fs.readFile(configPath, "utf-8")).resolves.toContain('"strict-plugin"');

        await expect(writeConfigFile(cfg, { skipPluginValidation: false })).rejects.toThrow(
          /Config validation failed/,
        );
        await expect(
          writeConfigFile({ agents: { list: "not-array" } } as unknown as OpenClawConfig, {
            skipPluginValidation: true,
          }),
        ).rejects.toThrow(/Config validation failed/);
      } finally {
        mockLoadPluginManifestRegistry.mockReturnValue({
          diagnostics: [],
          plugins: [],
        } satisfies PluginManifestRegistry);
        if (previousConfigPath === undefined) {
          delete process.env.OPENCLAW_CONFIG_PATH;
        } else {
          process.env.OPENCLAW_CONFIG_PATH = previousConfigPath;
        }
      }
    });
  });

  it("preserves authored tilde paths when runtime-shaped writes hand back absolute paths", async () => {
    await withSuiteHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(
        configPath,
        `${JSON.stringify(
          {
            logging: { file: "~/openclaw-upgrade-survivor/gateway.jsonl" },
          },
          null,
          2,
        )}\n`,
        "utf-8",
      );
      const io = createFastConfigIO(home);
      const snapshot = await io.readConfigFileSnapshot();

      await io.writeConfigFile(
        {
          logging: {
            file: path.join(home, "openclaw-upgrade-survivor", "gateway.jsonl"),
            level: "debug",
          },
        },
        { baseSnapshot: snapshot },
      );

      const persisted = JSON.parse(await fs.readFile(configPath, "utf-8")) as OpenClawConfig;
      expect(persisted.logging?.file).toBe("~/openclaw-upgrade-survivor/gateway.jsonl");
      expect(persisted.logging?.level).toBe("debug");
    });
  });
});

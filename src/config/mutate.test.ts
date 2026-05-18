import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import {
  ConfigMutationConflictError,
  mutateConfigFile,
  replaceConfigFile,
  transformConfigFileWithRetry,
} from "./mutate.js";
import { registerRuntimeConfigWriteListener, resetConfigRuntimeState } from "./runtime-snapshot.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "./types.js";

type MockValidationIssue = { path: string; message: string };
type MockValidationResult =
  | { ok: true; config: OpenClawConfig; warnings: MockValidationIssue[] }
  | { ok: false; issues: MockValidationIssue[]; warnings: MockValidationIssue[] };

const ioMocks = vi.hoisted(() => ({
  readConfigFileSnapshotForWrite: vi.fn(),
  resolveProtectedConfigPolicyWriteBlockingReasons: vi.fn(
    (_params: { explicitSetPaths?: readonly (readonly string[])[] }): string[] => [],
  ),
  resolveConfigSnapshotHash: vi.fn(),
  writeConfigFile: vi.fn(),
}));
const validationMocks = vi.hoisted(() => ({
  validateConfigObjectWithPlugins: vi.fn(
    (config: OpenClawConfig): MockValidationResult => ({
      ok: true,
      config,
      warnings: [],
    }),
  ),
}));

vi.mock("./io.js", () => ioMocks);
vi.mock("./validation.js", () => validationMocks);

function createSnapshot(params: {
  hash: string;
  path?: string;
  parsed?: unknown;
  sourceConfig: OpenClawConfig;
  runtimeConfig?: OpenClawConfig;
}): ConfigFileSnapshot {
  const runtimeConfig = (params.runtimeConfig ??
    params.sourceConfig) as ConfigFileSnapshot["config"];
  const sourceConfig = params.sourceConfig as ConfigFileSnapshot["sourceConfig"];
  return {
    path: params.path ?? "/tmp/openclaw.json",
    exists: true,
    raw: "{}",
    parsed: params.parsed ?? params.sourceConfig,
    sourceConfig,
    resolved: sourceConfig,
    valid: true,
    runtimeConfig,
    config: runtimeConfig,
    hash: params.hash,
    issues: [],
    warnings: [],
    legacyIssues: [],
  };
}

describe("config mutate helpers", () => {
  const suiteRootTracker = createSuiteTempRootTracker({ prefix: "openclaw-config-mutate-" });
  const originalNixMode = process.env.OPENCLAW_NIX_MODE;

  beforeAll(async () => {
    await suiteRootTracker.setup();
  });

  afterAll(async () => {
    if (originalNixMode === undefined) {
      delete process.env.OPENCLAW_NIX_MODE;
    } else {
      process.env.OPENCLAW_NIX_MODE = originalNixMode;
    }
    await suiteRootTracker.cleanup();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    resetConfigRuntimeState();
    validationMocks.validateConfigObjectWithPlugins.mockImplementation(
      (config: OpenClawConfig) => ({
        ok: true,
        config,
        warnings: [],
      }),
    );
    ioMocks.resolveConfigSnapshotHash.mockImplementation(
      (snapshot: { hash?: string }) => snapshot.hash ?? null,
    );
    ioMocks.resolveProtectedConfigPolicyWriteBlockingReasons.mockReset();
    ioMocks.resolveProtectedConfigPolicyWriteBlockingReasons.mockReturnValue([]);
    delete process.env.OPENCLAW_NIX_MODE;
  });

  it("mutates source config with optimistic hash protection", async () => {
    const snapshot = createSnapshot({
      hash: "source-hash",
      sourceConfig: { gateway: { port: 18789 } },
      runtimeConfig: { gateway: { port: 19001 } },
    });
    ioMocks.readConfigFileSnapshotForWrite.mockResolvedValue({
      snapshot,
      writeOptions: { expectedConfigPath: snapshot.path },
    });

    const result = await mutateConfigFile({
      baseHash: snapshot.hash,
      base: "source",
      mutate(draft) {
        draft.gateway = {
          ...draft.gateway,
          auth: { mode: "token" },
        };
      },
    });

    expect(result.previousHash).toBe("source-hash");
    expect(result.nextConfig.gateway).toEqual({
      port: 18789,
      auth: { mode: "token" },
    });
    expect(result.afterWrite).toEqual({ mode: "auto" });
    expect(result.followUp).toEqual({ mode: "auto", requiresRestart: false });
    expect(ioMocks.writeConfigFile).toHaveBeenCalledWith(
      {
        gateway: {
          port: 18789,
          auth: { mode: "token" },
        },
      },
      { baseSnapshot: snapshot, expectedConfigPath: snapshot.path, afterWrite: { mode: "auto" } },
    );
  });

  it("marks protected policy paths touched by transform mutations as explicit", async () => {
    const snapshot = createSnapshot({
      hash: "source-hash",
      sourceConfig: {
        channels: { telegram: { enabled: true, allowFrom: ["123"] } },
        tools: { elevated: { allowFrom: { telegram: ["123"] } } },
      },
    });
    ioMocks.readConfigFileSnapshotForWrite.mockResolvedValue({
      snapshot,
      writeOptions: { expectedConfigPath: snapshot.path },
    });

    await transformConfigFileWithRetry({
      baseHash: snapshot.hash,
      base: "source",
      transform(currentConfig) {
        return {
          nextConfig: {
            ...currentConfig,
            channels: { telegram: { enabled: true, allowFrom: ["456"] } },
            tools: { elevated: { allowFrom: { telegram: ["456"] } } },
          },
        };
      },
    });

    expect(ioMocks.writeConfigFile).toHaveBeenCalledWith(
      {
        channels: { telegram: { enabled: true, allowFrom: ["456"] } },
        tools: { elevated: { allowFrom: { telegram: ["456"] } } },
      },
      expect.objectContaining({
        explicitSetPaths: expect.arrayContaining([
          ["channels", "telegram", "allowFrom"],
          ["tools", "elevated", "allowFrom", "telegram"],
        ]),
      }),
    );
  });

  it("marks newly-created channel configs from transform mutations as explicit", async () => {
    const snapshot = createSnapshot({
      hash: "source-hash",
      sourceConfig: {},
    });
    ioMocks.readConfigFileSnapshotForWrite.mockResolvedValue({
      snapshot,
      writeOptions: { expectedConfigPath: snapshot.path },
    });

    await transformConfigFileWithRetry({
      baseHash: snapshot.hash,
      base: "source",
      transform(currentConfig) {
        return {
          nextConfig: {
            ...currentConfig,
            channels: { whatsapp: { enabled: true } },
          },
        };
      },
    });

    expect(ioMocks.writeConfigFile).toHaveBeenCalledWith(
      {
        channels: { whatsapp: { enabled: true } },
      },
      expect.objectContaining({
        explicitSetPaths: expect.arrayContaining([["channels", "whatsapp"]]),
      }),
    );
  });

  it("retries transform mutations on stale config conflicts", async () => {
    const initial = createSnapshot({
      hash: "hash-1",
      sourceConfig: { agents: { list: [] } },
    });
    const fresh = createSnapshot({
      hash: "hash-2",
      sourceConfig: { agents: { list: [{ id: "other-agent" }] } },
    });
    ioMocks.readConfigFileSnapshotForWrite
      .mockResolvedValueOnce({
        snapshot: initial,
        writeOptions: { expectedConfigPath: initial.path },
      })
      .mockResolvedValueOnce({
        snapshot: fresh,
        writeOptions: { expectedConfigPath: fresh.path },
      });
    ioMocks.writeConfigFile
      .mockRejectedValueOnce(new ConfigMutationConflictError("stale", { currentHash: "hash-2" }))
      .mockResolvedValueOnce(undefined);

    const result = await transformConfigFileWithRetry({
      io: ioMocks,
      transform(config, context) {
        return {
          nextConfig: {
            ...config,
            agents: {
              list: [...(config.agents?.list ?? []), { id: "work" }],
            },
          },
          result: context.attempt,
        };
      },
    });

    expect(result.attempts).toBe(2);
    expect(result.result).toBe(1);
    expect(ioMocks.writeConfigFile).toHaveBeenCalledTimes(2);
    expect(ioMocks.writeConfigFile).toHaveBeenNthCalledWith(
      2,
      {
        agents: {
          list: [{ id: "other-agent" }, { id: "work" }],
        },
      },
      { baseSnapshot: fresh, expectedConfigPath: fresh.path, afterWrite: { mode: "auto" } },
    );
  });

  it("serializes same-process transform mutations before reading snapshots", async () => {
    const initial = createSnapshot({
      hash: "hash-1",
      sourceConfig: { agents: { list: [] } },
    });
    const fresh = createSnapshot({
      hash: "hash-2",
      sourceConfig: { agents: { list: [{ id: "first" }] } },
    });
    ioMocks.readConfigFileSnapshotForWrite
      .mockResolvedValueOnce({
        snapshot: initial,
        writeOptions: { expectedConfigPath: initial.path },
      })
      .mockResolvedValueOnce({
        snapshot: fresh,
        writeOptions: { expectedConfigPath: fresh.path },
      });
    ioMocks.writeConfigFile.mockResolvedValue(undefined);

    let releaseFirstTransform!: () => void;
    let markFirstTransformStarted!: () => void;
    const firstTransformStarted = new Promise<void>((resolve) => {
      markFirstTransformStarted = resolve;
    });
    const first = transformConfigFileWithRetry({
      transform: async (config) => {
        markFirstTransformStarted();
        await new Promise<void>((release) => {
          releaseFirstTransform = release;
        });
        return {
          nextConfig: {
            ...config,
            agents: { list: [{ id: "first" }] },
          },
        };
      },
    });
    await firstTransformStarted;
    const second = transformConfigFileWithRetry({
      transform: (config) => ({
        nextConfig: {
          ...config,
          agents: {
            list: [...(config.agents?.list ?? []), { id: "second" }],
          },
        },
      }),
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(ioMocks.readConfigFileSnapshotForWrite).toHaveBeenCalledTimes(1);

    releaseFirstTransform();
    await Promise.all([first, second]);
    expect(ioMocks.writeConfigFile).toHaveBeenNthCalledWith(
      2,
      {
        agents: {
          list: [{ id: "first" }, { id: "second" }],
        },
      },
      { baseSnapshot: fresh, expectedConfigPath: fresh.path, afterWrite: { mode: "auto" } },
    );
  });

  it("rejects stale replace attempts when the base hash changed", async () => {
    ioMocks.readConfigFileSnapshotForWrite.mockResolvedValue({
      snapshot: createSnapshot({
        hash: "new-hash",
        sourceConfig: { gateway: { port: 19001 } },
      }),
      writeOptions: {},
    });

    await expect(
      replaceConfigFile({
        baseHash: "old-hash",
        nextConfig: { gateway: { port: 19002 } },
      }),
    ).rejects.toBeInstanceOf(ConfigMutationConflictError);
    expect(ioMocks.writeConfigFile).not.toHaveBeenCalled();
  });

  it("refuses replace writes in Nix mode before touching disk", async () => {
    process.env.OPENCLAW_NIX_MODE = "1";
    const snapshot = createSnapshot({
      hash: "hash-1",
      sourceConfig: { gateway: { port: 18789 } },
    });
    ioMocks.readConfigFileSnapshotForWrite.mockResolvedValue({
      snapshot,
      writeOptions: { expectedConfigPath: snapshot.path },
    });

    await expect(
      replaceConfigFile({
        nextConfig: { gateway: { port: 19001 } },
      }),
    ).rejects.toThrow(
      "Agent-first Nix setup: https://github.com/openclaw/nix-openclaw#quick-start",
    );

    expect(ioMocks.writeConfigFile).not.toHaveBeenCalled();
  });

  it("refuses mutate writes in Nix mode before touching disk", async () => {
    process.env.OPENCLAW_NIX_MODE = "1";
    const snapshot = createSnapshot({
      hash: "hash-1",
      sourceConfig: { gateway: { port: 18789 } },
    });
    ioMocks.readConfigFileSnapshotForWrite.mockResolvedValue({
      snapshot,
      writeOptions: { expectedConfigPath: snapshot.path },
    });

    await expect(
      mutateConfigFile({
        mutate(draft) {
          draft.gateway = { ...draft.gateway, port: 19001 };
        },
      }),
    ).rejects.toThrow("OpenClaw Nix overview: https://docs.openclaw.ai/install/nix");

    expect(ioMocks.writeConfigFile).not.toHaveBeenCalled();
  });

  it("reuses a provided snapshot and write options for replace", async () => {
    const snapshot = createSnapshot({
      hash: "hash-1",
      sourceConfig: { gateway: { auth: { mode: "token" } } },
    });

    await replaceConfigFile({
      baseHash: snapshot.hash,
      nextConfig: { gateway: { auth: { mode: "token", token: "minted" } } },
      snapshot,
      writeOptions: { expectedConfigPath: snapshot.path },
    });

    expect(ioMocks.readConfigFileSnapshotForWrite).not.toHaveBeenCalled();
    expect(ioMocks.writeConfigFile).toHaveBeenCalledWith(
      { gateway: { auth: { mode: "token", token: "minted" } } },
      {
        baseSnapshot: snapshot,
        expectedConfigPath: snapshot.path,
        afterWrite: { mode: "auto" },
      },
    );
  });

  it("uses skipPluginValidation for replace pre-write snapshots", async () => {
    const snapshot = createSnapshot({
      hash: "hash-1",
      sourceConfig: { plugins: { entries: { "strict-plugin": { enabled: true } } } },
    });
    ioMocks.readConfigFileSnapshotForWrite.mockResolvedValue({
      snapshot,
      writeOptions: { expectedConfigPath: snapshot.path },
    });

    await replaceConfigFile({
      nextConfig: { plugins: { entries: { "strict-plugin": { enabled: false } } } },
      writeOptions: { skipPluginValidation: true },
    });

    expect(ioMocks.readConfigFileSnapshotForWrite).toHaveBeenCalledWith({
      skipPluginValidation: true,
    });
    expect(ioMocks.writeConfigFile).toHaveBeenCalledWith(
      { plugins: { entries: { "strict-plugin": { enabled: false } } } },
      {
        baseSnapshot: snapshot,
        expectedConfigPath: snapshot.path,
        skipPluginValidation: true,
        afterWrite: { mode: "auto" },
      },
    );
  });

  it("returns explicit restart follow-up intent for replace writes", async () => {
    const snapshot = createSnapshot({
      hash: "hash-restart",
      sourceConfig: { gateway: { auth: { mode: "token" } } },
    });

    const result = await replaceConfigFile({
      baseHash: snapshot.hash,
      nextConfig: { gateway: { auth: { mode: "token", token: "minted" } } },
      snapshot,
      afterWrite: { mode: "restart", reason: "plugin auth changed" },
      writeOptions: { expectedConfigPath: snapshot.path },
    });

    expect(result.afterWrite).toEqual({ mode: "restart", reason: "plugin auth changed" });
    expect(result.followUp).toEqual({
      mode: "restart",
      reason: "plugin auth changed",
      requiresRestart: true,
    });
    expect(ioMocks.writeConfigFile).toHaveBeenCalledWith(
      { gateway: { auth: { mode: "token", token: "minted" } } },
      {
        baseSnapshot: snapshot,
        expectedConfigPath: snapshot.path,
        afterWrite: { mode: "restart", reason: "plugin auth changed" },
      },
    );
  });

  it("returns the canonical persisted config from replace writes", async () => {
    const snapshot = createSnapshot({
      hash: "hash-persisted",
      sourceConfig: { gateway: { auth: { mode: "token" } } },
    });
    ioMocks.writeConfigFile.mockResolvedValue({
      persistedHash: "hash-after",
      persistedConfig: {
        gateway: { auth: { mode: "token", token: "minted" } },
        meta: { lastTouchedVersion: "test" },
      },
    });

    const result = await replaceConfigFile({
      baseHash: snapshot.hash,
      nextConfig: { gateway: { auth: { mode: "token", token: "minted" } } },
      snapshot,
      writeOptions: { expectedConfigPath: snapshot.path },
    });

    expect(result.persistedHash).toBe("hash-after");
    expect(result.nextConfig).toEqual({
      gateway: { auth: { mode: "token", token: "minted" } },
      meta: { lastTouchedVersion: "test" },
    });
  });

  it("writes through a single-file top-level plugins include", async () => {
    const home = await suiteRootTracker.make("include");
    const configPath = path.join(home, ".openclaw", "openclaw.json");
    const pluginsPath = path.join(home, ".openclaw", "config", "plugins.json5");
    await fs.mkdir(path.dirname(pluginsPath), { recursive: true });
    await fs.writeFile(
      configPath,
      `${JSON.stringify({ plugins: { $include: "./config/plugins.json5" } }, null, 2)}\n`,
      "utf-8",
    );
    await fs.writeFile(
      pluginsPath,
      `${JSON.stringify({ entries: { old: { enabled: true } } }, null, 2)}\n`,
      "utf-8",
    );
    const snapshot = createSnapshot({
      hash: "hash-include",
      path: configPath,
      parsed: { plugins: { $include: "./config/plugins.json5" } },
      sourceConfig: {
        plugins: {
          entries: { old: { enabled: true } },
        },
      },
    });
    const refreshedSnapshot = createSnapshot({
      hash: "hash-include-refreshed",
      path: configPath,
      parsed: { plugins: { $include: "./config/plugins.json5" } },
      sourceConfig: {
        plugins: {
          entries: {
            old: { enabled: true },
            demo: { enabled: true },
          },
        },
      },
    });
    ioMocks.readConfigFileSnapshotForWrite.mockResolvedValue({
      snapshot: refreshedSnapshot,
      writeOptions: { expectedConfigPath: configPath },
    });
    const notifications: unknown[] = [];
    const unregister = registerRuntimeConfigWriteListener((event) => {
      notifications.push(event);
    });

    try {
      await replaceConfigFile({
        baseHash: snapshot.hash,
        snapshot,
        afterWrite: { mode: "restart", reason: "test include refresh" },
        writeOptions: {
          expectedConfigPath: snapshot.path,
          unsetPaths: [["plugins", "installs"]],
        },
        nextConfig: {
          plugins: {
            entries: {
              old: { enabled: true },
              demo: { enabled: true },
            },
            installs: {
              demo: {
                source: "npm",
                spec: "demo",
                installPath: "/tmp/demo",
              },
            },
          },
        },
      });
    } finally {
      unregister();
    }

    expect(ioMocks.writeConfigFile).not.toHaveBeenCalled();
    expect(notifications).toHaveLength(1);
    const [notification] = notifications as Array<{
      configPath?: string;
      persistedHash?: string;
      sourceConfig?: unknown;
      runtimeConfig?: unknown;
      afterWrite?: unknown;
    }>;
    expect(notification?.configPath).toBe(configPath);
    expect(notification?.persistedHash).toBe("hash-include-refreshed");
    expect(notification?.sourceConfig).toEqual({
      plugins: {
        entries: {
          old: { enabled: true },
          demo: { enabled: true },
        },
      },
    });
    expect(notification?.runtimeConfig).toEqual({
      plugins: {
        entries: {
          old: { enabled: true },
          demo: { enabled: true },
        },
      },
    });
    expect(notification?.afterWrite).toEqual({ mode: "restart", reason: "test include refresh" });
    await expect(fs.readFile(configPath, "utf-8")).resolves.toContain(
      '"$include": "./config/plugins.json5"',
    );
    await expect(fs.readFile(`${pluginsPath}.bak`, "utf-8")).resolves.toContain('"old"');
    const persistedPlugins = JSON.parse(await fs.readFile(pluginsPath, "utf-8")) as {
      entries?: Record<string, unknown>;
      installs?: Record<string, unknown>;
    };
    expect(persistedPlugins.entries?.demo).toEqual({ enabled: true });
    expect(persistedPlugins.installs).toBeUndefined();
  });

  it("keeps single-file top-level plugins include writes when plugin validation is skipped", async () => {
    const home = await suiteRootTracker.make("include-skip-plugin-validation");
    const configPath = path.join(home, ".openclaw", "openclaw.json");
    const pluginsPath = path.join(home, ".openclaw", "config", "plugins.json5");
    await fs.mkdir(path.dirname(pluginsPath), { recursive: true });
    await fs.writeFile(
      configPath,
      `${JSON.stringify({ plugins: { $include: "./config/plugins.json5" } }, null, 2)}\n`,
      "utf-8",
    );
    await fs.writeFile(pluginsPath, `${JSON.stringify({ entries: {} }, null, 2)}\n`, "utf-8");
    const snapshot = createSnapshot({
      hash: "hash-include-skip",
      path: configPath,
      parsed: { plugins: { $include: "./config/plugins.json5" } },
      sourceConfig: { plugins: { entries: {} } },
    });
    const refreshedSnapshot = createSnapshot({
      hash: "hash-include-skip-refreshed",
      path: configPath,
      parsed: { plugins: { $include: "./config/plugins.json5" } },
      sourceConfig: {
        plugins: {
          entries: {
            "strict-plugin": { enabled: true },
          },
        },
      },
    });
    ioMocks.readConfigFileSnapshotForWrite.mockResolvedValue({
      snapshot: refreshedSnapshot,
      writeOptions: { expectedConfigPath: configPath },
    });
    const nextConfig: OpenClawConfig = {
      plugins: {
        entries: {
          "strict-plugin": { enabled: true },
        },
      },
    };

    await replaceConfigFile({
      baseHash: snapshot.hash,
      snapshot,
      writeOptions: {
        expectedConfigPath: snapshot.path,
        skipPluginValidation: true,
      },
      nextConfig,
    });

    expect(ioMocks.writeConfigFile).not.toHaveBeenCalled();
    expect(validationMocks.validateConfigObjectWithPlugins).toHaveBeenCalledWith(nextConfig, {
      pluginValidation: "skip",
    });
    expect(ioMocks.readConfigFileSnapshotForWrite).toHaveBeenCalledWith({
      skipPluginValidation: true,
    });
    await expect(fs.readFile(configPath, "utf-8")).resolves.toContain(
      '"$include": "./config/plugins.json5"',
    );
    const persistedPlugins = JSON.parse(await fs.readFile(pluginsPath, "utf-8")) as {
      entries?: Record<string, unknown>;
    };
    expect(persistedPlugins.entries?.["strict-plugin"]).toEqual({ enabled: true });
  });

  it("rejects protected policy drops before writing top-level includes", async () => {
    const home = await suiteRootTracker.make("include-protected-policy");
    const configPath = path.join(home, ".openclaw", "openclaw.json");
    const channelsPath = path.join(home, ".openclaw", "config", "channels.json5");
    await fs.mkdir(path.dirname(channelsPath), { recursive: true });
    await fs.writeFile(
      configPath,
      `${JSON.stringify({ channels: { $include: "./config/channels.json5" } }, null, 2)}\n`,
      "utf-8",
    );
    await fs.writeFile(
      channelsPath,
      `${JSON.stringify({ whatsapp: { allowFrom: ["+15550001111"] } }, null, 2)}\n`,
      "utf-8",
    );
    const snapshot = createSnapshot({
      hash: "hash-include-protected",
      path: configPath,
      parsed: { channels: { $include: "./config/channels.json5" } },
      sourceConfig: {
        channels: {
          whatsapp: { allowFrom: ["+15550001111"] },
        },
      },
    });
    ioMocks.resolveProtectedConfigPolicyWriteBlockingReasons.mockReturnValueOnce([
      "protected-channel-config-changed:channels.whatsapp",
    ]);

    await expect(
      replaceConfigFile({
        baseHash: snapshot.hash,
        snapshot,
        writeOptions: {},
        nextConfig: { channels: { whatsapp: {} } },
      }),
    ).rejects.toMatchObject({
      code: "CONFIG_WRITE_REJECTED",
      reasons: ["protected-channel-config-changed:channels.whatsapp"],
    });
    await expect(fs.readFile(channelsPath, "utf-8")).resolves.toContain("+15550001111");
    expect(ioMocks.writeConfigFile).not.toHaveBeenCalled();
  });

  it("treats include-path unsets as explicit protected policy edits", async () => {
    const home = await suiteRootTracker.make("include-explicit-unset");
    const configPath = path.join(home, ".openclaw", "openclaw.json");
    const channelsPath = path.join(home, ".openclaw", "config", "channels.json5");
    await fs.mkdir(path.dirname(channelsPath), { recursive: true });
    await fs.writeFile(
      configPath,
      `${JSON.stringify({ channels: { $include: "./config/channels.json5" } }, null, 2)}\n`,
      "utf-8",
    );
    await fs.writeFile(
      channelsPath,
      `${JSON.stringify({ whatsapp: { allowFrom: ["+15550001111"] } }, null, 2)}\n`,
      "utf-8",
    );
    const snapshot = createSnapshot({
      hash: "hash-include-unset",
      path: configPath,
      parsed: { channels: { $include: "./config/channels.json5" } },
      sourceConfig: {
        channels: {
          whatsapp: { allowFrom: ["+15550001111"] },
        },
      },
    });
    ioMocks.resolveProtectedConfigPolicyWriteBlockingReasons.mockImplementationOnce((params) => {
      expect(params.explicitSetPaths).toEqual(
        expect.arrayContaining([["channels", "whatsapp", "allowFrom"]]),
      );
      return [];
    });

    await replaceConfigFile({
      baseHash: snapshot.hash,
      snapshot,
      writeOptions: {
        unsetPaths: [["channels", "whatsapp", "allowFrom"]],
      },
      nextConfig: {
        channels: {
          whatsapp: { allowFrom: ["+15550001111"] },
        },
      },
    });

    const persistedChannels = JSON.parse(await fs.readFile(channelsPath, "utf-8")) as {
      whatsapp?: Record<string, unknown>;
    };
    expect(persistedChannels.whatsapp?.allowFrom).toBeUndefined();
    expect(ioMocks.writeConfigFile).not.toHaveBeenCalled();
  });

  it("falls back to root writes for unsets that remove a top-level include", async () => {
    const home = await suiteRootTracker.make("include-root-unset");
    const configPath = path.join(home, ".openclaw", "openclaw.json");
    const channelsPath = path.join(home, ".openclaw", "config", "channels.json5");
    await fs.mkdir(path.dirname(channelsPath), { recursive: true });
    await fs.writeFile(
      configPath,
      `${JSON.stringify({ channels: { $include: "./config/channels.json5" } }, null, 2)}\n`,
      "utf-8",
    );
    await fs.writeFile(
      channelsPath,
      `${JSON.stringify({ whatsapp: { enabled: true } }, null, 2)}\n`,
      "utf-8",
    );
    const snapshot = createSnapshot({
      hash: "hash-include-root-unset",
      path: configPath,
      parsed: { channels: { $include: "./config/channels.json5" } },
      sourceConfig: {
        channels: {
          whatsapp: { enabled: true },
        },
      },
    });

    await replaceConfigFile({
      baseHash: snapshot.hash,
      snapshot,
      writeOptions: {
        unsetPaths: [["channels"]],
      },
      nextConfig: {
        channels: {
          whatsapp: { enabled: true },
        },
      },
    });

    expect(ioMocks.writeConfigFile).toHaveBeenCalledWith(
      {
        channels: {
          whatsapp: { enabled: true },
        },
      },
      expect.objectContaining({
        baseSnapshot: snapshot,
        unsetPaths: [["channels"]],
      }),
    );
    await expect(fs.readFile(channelsPath, "utf-8")).resolves.toContain("whatsapp");
  });

  it("falls back to root writes when a top-level include key is absent from the next config", async () => {
    const home = await suiteRootTracker.make("include-root-absent");
    const configPath = path.join(home, ".openclaw", "openclaw.json");
    const channelsPath = path.join(home, ".openclaw", "config", "channels.json5");
    await fs.mkdir(path.dirname(channelsPath), { recursive: true });
    await fs.writeFile(
      configPath,
      `${JSON.stringify({ channels: { $include: "./config/channels.json5" } }, null, 2)}\n`,
      "utf-8",
    );
    await fs.writeFile(
      channelsPath,
      `${JSON.stringify({ whatsapp: { enabled: true } }, null, 2)}\n`,
      "utf-8",
    );
    const snapshot = createSnapshot({
      hash: "hash-include-root-absent",
      path: configPath,
      parsed: { channels: { $include: "./config/channels.json5" } },
      sourceConfig: {
        channels: {
          whatsapp: { enabled: true },
        },
      },
    });

    await replaceConfigFile({
      baseHash: snapshot.hash,
      snapshot,
      writeOptions: {},
      nextConfig: {},
    });

    expect(ioMocks.writeConfigFile).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        baseSnapshot: snapshot,
      }),
    );
    await expect(fs.readFile(channelsPath, "utf-8")).resolves.toContain("whatsapp");
  });

  it("rejects invalid base config before skipped-plugin include writes", async () => {
    const home = await suiteRootTracker.make("include-skip-invalid-base");
    const configPath = path.join(home, ".openclaw", "openclaw.json");
    const pluginsPath = path.join(home, ".openclaw", "config", "plugins.json5");
    await fs.mkdir(path.dirname(pluginsPath), { recursive: true });
    await fs.writeFile(
      configPath,
      `${JSON.stringify({ plugins: { $include: "./config/plugins.json5" } }, null, 2)}\n`,
      "utf-8",
    );
    await fs.writeFile(
      pluginsPath,
      `${JSON.stringify({ entries: { old: { enabled: true } } }, null, 2)}\n`,
      "utf-8",
    );
    const snapshot = createSnapshot({
      hash: "hash-include-invalid-base",
      path: configPath,
      parsed: { plugins: { $include: "./config/plugins.json5" } },
      sourceConfig: { plugins: { entries: { old: { enabled: true } } } },
    });
    const nextConfig = {
      plugins: {
        entries: {
          "strict-plugin": { enabled: "yes" },
        },
      },
    } as unknown as OpenClawConfig;
    validationMocks.validateConfigObjectWithPlugins.mockReturnValue({
      ok: false,
      issues: [
        {
          path: "plugins.entries.strict-plugin.enabled",
          message: "Expected boolean",
        },
      ],
      warnings: [],
    });

    await expect(
      replaceConfigFile({
        baseHash: snapshot.hash,
        snapshot,
        writeOptions: {
          expectedConfigPath: snapshot.path,
          skipPluginValidation: true,
        },
        nextConfig,
      }),
    ).rejects.toThrow("plugins.entries.strict-plugin.enabled: Expected boolean");

    expect(ioMocks.writeConfigFile).not.toHaveBeenCalled();
    expect(ioMocks.readConfigFileSnapshotForWrite).not.toHaveBeenCalled();
    const persistedPlugins = JSON.parse(await fs.readFile(pluginsPath, "utf-8")) as {
      entries?: Record<string, unknown>;
    };
    expect(persistedPlugins.entries).toEqual({ old: { enabled: true } });
  });

  it("falls back to the root writer when a plugins include write is not isolated", async () => {
    const snapshot = createSnapshot({
      hash: "hash-multi",
      path: "/tmp/openclaw.json",
      parsed: { plugins: { $include: "./config/plugins.json5" }, gateway: { mode: "local" } },
      sourceConfig: {
        gateway: { mode: "local" },
        plugins: { entries: {} },
      },
    });

    await replaceConfigFile({
      snapshot,
      writeOptions: { expectedConfigPath: snapshot.path },
      nextConfig: {
        gateway: { mode: "local", port: 18789 },
        plugins: { entries: { demo: { enabled: true } } },
      },
    });

    expect(ioMocks.writeConfigFile).toHaveBeenCalledWith(
      {
        gateway: { mode: "local", port: 18789 },
        plugins: { entries: { demo: { enabled: true } } },
      },
      {
        baseSnapshot: snapshot,
        expectedConfigPath: snapshot.path,
        afterWrite: { mode: "auto" },
      },
    );
  });
});

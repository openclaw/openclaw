// Covers config mutation helpers and persisted write behavior.
import fsNode from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as tmpDirOwner from "../infra/tmp-openclaw-dir.js";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  applyConfigEnvVars,
  captureConfigReadEnvMutation,
  initializePublishedConfigRuntimeEnv,
  prepareConfigRuntimeEnv,
} from "./config-env-vars.js";
import { setConfigValueAtPath } from "./config-paths.js";
import {
  collectChangedConfigPaths,
  resolveIncludeWriteBoundary,
} from "./include-write-boundary.js";
import { hashConfigIncludeRaw } from "./includes.js";
import { createConfigIO as createActualConfigIO } from "./io.factory.js";
import type { ConfigWriteOptions } from "./io.js";
import { configWriteCommittedSnapshot } from "./io.types.js";
import {
  ConfigMutationConflictError,
  resolveConfigIncludeWriteBoundary,
  mutateConfigFile,
  replaceConfigFile,
  transformConfigFileWithRetry,
} from "./mutate.js";
import {
  registerPluginIncludeReferenceRepairTest,
  registerIncludeReferencePreflightTest,
} from "./mutate.reference.test-support.js";
import {
  createPluginIncludeFixture,
  createSnapshot,
  mockIncludeRollbackRename,
  resolveIncludeTarget,
} from "./mutate.test-support.js";
import { resolveConfigPath } from "./paths.js";
import {
  registerManagedRuntimeConfigWriteOwner,
  resetConfigRuntimeState,
  setRuntimeConfigSnapshot,
  setRuntimeConfigSnapshotRefreshHandler,
} from "./runtime-snapshot.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "./types.js";

type MockValidationIssue = { path: string; message: string };
type MockValidationResult =
  | { ok: true; config: OpenClawConfig; warnings: MockValidationIssue[] }
  | { ok: false; issues: MockValidationIssue[]; warnings: MockValidationIssue[] };
type ConfigIOReadForWrite = ReturnType<
  typeof import("./io.js").createConfigIO
>["readConfigFileSnapshotForWrite"];

const ioMocks = vi.hoisted(() => {
  const readConfigFileSnapshotForWrite = vi.fn<ConfigIOReadForWrite>();
  return {
    createConfigIO: vi.fn(
      (
        _options?: Parameters<typeof import("./io.js").createConfigIO>[0],
      ): { readConfigFileSnapshotForWrite: ConfigIOReadForWrite } => ({
        readConfigFileSnapshotForWrite,
      }),
    ),
    readConfigFileSnapshotForWrite,
    resolveConfigSnapshotHash: vi.fn(),
    writeConfigFile: vi.fn(),
  };
});
const validationMocks = vi.hoisted(() => ({
  validateConfigObjectWithPlugins: vi.fn((config: OpenClawConfig): MockValidationResult => ({
    ok: true,
    config,
    warnings: [],
  })),
}));
const backupMocks = vi.hoisted(() => ({
  prepareConfigFileWrite: vi.fn<typeof import("./backup-rotation.js").prepareConfigFileWrite>(),
}));
const fileLockMocks = vi.hoisted(() => ({
  withFileLock: vi.fn<typeof import("../infra/file-lock.js").withFileLock>(),
}));

vi.mock("./io.js", async () => ({
  ...(await vi.importActual<typeof import("./io.js")>("./io.js")),
  ...ioMocks,
}));
vi.mock("./validation.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./validation.js")>()),
  ...validationMocks,
}));
vi.mock("./backup-rotation.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./backup-rotation.js")>();
  backupMocks.prepareConfigFileWrite.mockImplementation(actual.prepareConfigFileWrite);
  return {
    ...actual,
    prepareConfigFileWrite: backupMocks.prepareConfigFileWrite,
  };
});
vi.mock("../infra/file-lock.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/file-lock.js")>()),
  withFileLock: fileLockMocks.withFileLock,
}));

const allowConfigPathWrite = () => {};
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const enabledPlugin = { plugins: { entries: { demo: { enabled: true } } } };

function includeSnapshot(configPath: string, sourceConfig: OpenClawConfig): ConfigFileSnapshot {
  return createSnapshot({
    hash: "include-hash",
    path: configPath,
    parsed: { plugins: { $include: "./config/plugins.json5" } },
    sourceConfig,
  });
}

function includeIO(configPath: string) {
  return createActualConfigIO({
    env: { ...process.env, OPENCLAW_CONFIG_PATH: configPath },
    observe: false,
    pluginValidation: "skip",
  });
}

function readResult(snapshot: ConfigFileSnapshot, writeOptions: ConfigWriteOptions = {}) {
  return { snapshot, writeOptions: { expectedConfigPath: snapshot.path, ...writeOptions } };
}

async function includeWriteOptions(
  snapshot: ConfigFileSnapshot,
  includePath: string,
): Promise<ConfigWriteOptions> {
  return {
    expectedConfigPath: snapshot.path,
    assertConfigPathForWrite: allowConfigPathWrite,
    includeFileTargetsForWrite: { [includePath]: await resolveIncludeTarget(includePath) },
  };
}

async function expectPluginIncludeMutationConflict(
  snapshot: ConfigFileSnapshot,
  pluginsPath: string,
) {
  await expect(
    replaceConfigFile({
      baseHash: snapshot.hash,
      snapshot,
      writeOptions: await includeWriteOptions(snapshot, pluginsPath),
      nextConfig: enabledPlugin,
    }),
  ).rejects.toBeInstanceOf(ConfigMutationConflictError);
}

describe("config mutate helpers", () => {
  const suiteRootTracker = createSuiteTempRootTracker({ prefix: "openclaw-config-mutate-" });
  const originalNixMode = process.env.OPENCLAW_NIX_MODE;

  async function pluginFixture(
    name: string,
    plugins: NonNullable<OpenClawConfig["plugins"]> = { entries: {} },
  ) {
    const { configPath, pluginsPath } = await createPluginIncludeFixture(
      await suiteRootTracker.make(name),
    );
    const initialPluginsRaw = json(plugins);
    await fs.writeFile(pluginsPath, initialPluginsRaw, "utf-8");
    const snapshot = includeSnapshot(configPath, { plugins });
    return { configPath, pluginsPath, initialPluginsRaw, snapshot };
  }

  beforeAll(async () => {
    await suiteRootTracker.setup();
    vi.spyOn(tmpDirOwner, "resolvePreferredOpenClawTmpDir").mockReturnValue(
      await suiteRootTracker.make("coordinator"),
    );
  });

  afterAll(async () => {
    if (originalNixMode === undefined) {
      delete process.env.OPENCLAW_NIX_MODE;
    } else {
      process.env.OPENCLAW_NIX_MODE = originalNixMode;
    }
    vi.mocked(tmpDirOwner.resolvePreferredOpenClawTmpDir).mockRestore();
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
    fileLockMocks.withFileLock.mockImplementation(async (_filePath, _options, fn) => await fn());
    delete process.env.OPENCLAW_NIX_MODE;
  });

  it("mutates the source config rather than the runtime projection", async () => {
    const snapshot = createSnapshot({
      path: resolveConfigPath(),
      hash: "source-hash",
      sourceConfig: { gateway: { port: 18789 } },
      runtimeConfig: { gateway: { port: 19001 } },
    });
    ioMocks.readConfigFileSnapshotForWrite.mockResolvedValue(readResult(snapshot));
    const nextConfig = { gateway: { port: 18789, auth: { mode: "token" as const } } };
    ioMocks.writeConfigFile.mockResolvedValue({
      persistedConfig: nextConfig,
      persistedHash: "written",
    });
    const result = await mutateConfigFile({
      baseHash: snapshot.hash,
      base: "source",
      mutate(draft) {
        draft.gateway = { ...draft.gateway, auth: { mode: "token" } };
      },
    });
    expect(ioMocks.writeConfigFile).toHaveBeenCalledWith(nextConfig, {
      baseSnapshot: snapshot,
      expectedConfigPath: snapshot.path,
      afterWrite: { mode: "auto" },
      inputBase: "source",
    });
    expect(result.nextConfig).toEqual(nextConfig);
    expect(result.previousHash).toBe("source-hash");
    expect(result.persistedHash).toBe("written");
    expect(result.followUp).toEqual({ mode: "auto", requiresRestart: false });
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
      .mockResolvedValueOnce(readResult(initial, { ownedConfigPathForWrite: initial.path }))
      .mockResolvedValueOnce(readResult(fresh, { ownedConfigPathForWrite: fresh.path }));
    ioMocks.writeConfigFile
      .mockRejectedValueOnce(new ConfigMutationConflictError("stale"))
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
      {
        baseSnapshot: fresh,
        inputBase: "source",
        expectedConfigPath: fresh.path,
        ownedConfigPathForWrite: initial.path,
        afterWrite: { mode: "auto" },
        preCommitRuntimePreflight: expect.any(Function),
      },
    );
  });

  it("captures retry ownership before checking a caller base hash", async () => {
    const initial = createSnapshot({
      hash: "hash-1",
      path: "/tmp/first-openclaw.json",
      sourceConfig: { agents: { list: [] } },
    });
    const fresh = createSnapshot({
      hash: "hash-2",
      path: "/tmp/second-openclaw.json",
      sourceConfig: { agents: { list: [] } },
    });
    ioMocks.readConfigFileSnapshotForWrite
      .mockResolvedValueOnce(readResult(initial, { ownedConfigPathForWrite: initial.path }))
      .mockResolvedValueOnce(readResult(fresh, { ownedConfigPathForWrite: fresh.path }));
    const transform = vi.fn((config: OpenClawConfig) => ({ nextConfig: config }));

    await expect(
      transformConfigFileWithRetry({
        baseHash: fresh.hash,
        io: ioMocks,
        transform,
      }),
    ).rejects.toThrow("config path changed since last load");

    expect(ioMocks.readConfigFileSnapshotForWrite).toHaveBeenCalledTimes(2);
    expect(transform).not.toHaveBeenCalled();
    expect(ioMocks.writeConfigFile).not.toHaveBeenCalled();
  });

  it("serializes same-process transform mutations before reading snapshots", async () => {
    const configPath = resolveConfigPath();
    const initial = createSnapshot({
      hash: "hash-1",
      path: configPath,
      sourceConfig: { agents: { list: [] } },
    });
    const fresh = createSnapshot({
      hash: "hash-2",
      path: configPath,
      sourceConfig: { agents: { list: [{ id: "first" }] } },
    });
    ioMocks.readConfigFileSnapshotForWrite
      .mockResolvedValueOnce(readResult(initial))
      .mockResolvedValue(readResult(fresh));
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
      {
        baseSnapshot: fresh,
        expectedConfigPath: fresh.path,
        afterWrite: { mode: "auto" },
        inputBase: "source",
      },
    );
  });

  it.runIf(process.platform !== "win32")(
    "diagnoses config lock failures through a symlinked config directory",
    async () => {
      const root = await suiteRootTracker.make("lock-permission-symlink");
      const realConfigDir = path.join(root, "real");
      const configuredDir = path.join(root, "configured");
      await fs.mkdir(realConfigDir);
      await fs.symlink(realConfigDir, configuredDir);
      const configPath = path.join(configuredDir, "openclaw.json");
      const lockPath = path.join(realConfigDir, "openclaw.json.lock");
      const failure = Object.assign(new Error(`EACCES: permission denied, open '${lockPath}'`), {
        code: "EACCES",
        path: lockPath,
      });
      fileLockMocks.withFileLock.mockRejectedValueOnce(failure);
      const snapshot = createSnapshot({ hash: "hash-1", path: configPath, sourceConfig: {} });

      await expect(replaceConfigFile({ snapshot, nextConfig: {} })).rejects.toMatchObject({
        message: `OpenClaw cannot write to the config directory ${configuredDir}. Fix its ownership or permissions, then try again. Underlying error: ${failure.message}`,
        cause: failure,
      });
    },
  );

  it("preserves a permission failure raised outside the config directory", async () => {
    const configDir = await suiteRootTracker.make("lock-unrelated-permission");
    const configPath = path.join(configDir, "openclaw.json");
    // The caller's mutation runs inside the lock scope, so its own EACCES must not be
    // relabelled as a config-directory permission problem.
    const failure = Object.assign(
      new Error("EACCES: permission denied, open '/elsewhere/secret'"),
      {
        code: "EACCES",
        path: "/elsewhere/secret",
      },
    );
    fileLockMocks.withFileLock.mockRejectedValueOnce(failure);
    const snapshot = createSnapshot({ hash: "hash-1", path: configPath, sourceConfig: {} });

    await expect(replaceConfigFile({ snapshot, nextConfig: {} })).rejects.toBe(failure);
  });

  it("refuses Nix-managed config writes before touching disk", async () => {
    await withEnvAsync({ OPENCLAW_NIX_MODE: "1" }, async () => {
      await expect(replaceConfigFile({ nextConfig: { gateway: { port: 19001 } } })).rejects.toThrow(
        "OPENCLAW_NIX_MODE=1",
      );
      expect(ioMocks.writeConfigFile).not.toHaveBeenCalled();
    });
  });

  it("does not report a root-only hash as the revision of an included config", async () => {
    const nextConfig = { gateway: { port: 19001 } };
    const snapshot = createSnapshot({
      hash: "before",
      path: resolveConfigPath(),
      sourceConfig: {},
    });
    const persistedConfig = { ...nextConfig, $include: "extra.json5" };
    ioMocks.readConfigFileSnapshotForWrite.mockResolvedValue(readResult(snapshot));
    ioMocks.writeConfigFile.mockResolvedValue({ persistedHash: "root-only", persistedConfig });
    const result = await replaceConfigFile({ baseHash: snapshot.hash, nextConfig });
    expect(result.persistedHash).toBeNull();
    expect(result.nextConfig).toEqual(persistedConfig);
    expect(ioMocks.writeConfigFile).toHaveBeenCalledWith(nextConfig, {
      baseSnapshot: snapshot,
      expectedConfigPath: snapshot.path,
      afterWrite: { mode: "auto" },
    });
  });

  it("refuses a shared fragment reached through an alias in a merged sibling", async () => {
    const home = await suiteRootTracker.make("shared-include-owner");
    const configPath = path.join(home, "openclaw.json");
    const fragmentPath = path.join(home, "fragment.json5");
    await fs.symlink(fragmentPath, path.join(home, "alias.json5"));
    const rootRaw = JSON.stringify({
      plugins: {
        entries: {
          alpha: { $include: "./fragment.json5" },
          beta: { $include: ["./alias.json5"] },
        },
      },
    });
    const fragmentRaw = JSON.stringify({ enabled: false });
    await fs.writeFile(configPath, rootRaw);
    await fs.writeFile(fragmentPath, fragmentRaw);
    const configIO = includeIO(configPath);
    const { snapshot, writeOptions } = await configIO.readConfigFileSnapshotForWrite();
    const nextConfig = structuredClone(snapshot.sourceConfig);
    setConfigValueAtPath(nextConfig, ["plugins", "entries", "alpha", "enabled"], true);
    expect(resolveConfigIncludeWriteBoundary({ snapshot, nextConfig })).toBeNull();
    await expect(
      replaceConfigFile({
        snapshot,
        baseHash: snapshot.hash,
        nextConfig,
        writeOptions,
        io: {
          readConfigFileSnapshotForWrite: () => configIO.readConfigFileSnapshotForWrite(),
          writeConfigFile: (config, options) => configIO.writeConfigFile(config, options),
        },
      }),
    ).rejects.toThrow("Config write would flatten $include-owned config");
    await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(rootRaw);
    await expect(fs.readFile(fragmentPath, "utf-8")).resolves.toBe(fragmentRaw);
    expect((await configIO.readConfigFileSnapshot()).sourceConfig).toEqual(snapshot.sourceConfig);
  });

  it("rejects a nested delegate shadowed by a same-path include array", async () => {
    const home = await suiteRootTracker.make("same-path-include-array");
    const configPath = path.join(home, ".openclaw", "openclaw.json");
    const delegatePath = path.join(home, ".openclaw", "delegate.json5");
    const nestedPath = path.join(home, ".openclaw", "nested.json5");
    const overridePath = path.join(home, ".openclaw", "override.json5");
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(
      configPath,
      JSON.stringify({ plugins: { $include: ["./delegate.json5", "./override.json5"] } }),
    );
    await fs.writeFile(delegatePath, JSON.stringify({ $include: "./nested.json5" }));
    const nestedRaw = JSON.stringify({ entries: { demo: { enabled: false } } });
    await fs.writeFile(nestedPath, nestedRaw);
    await fs.writeFile(overridePath, JSON.stringify({ entries: { demo: { enabled: false } } }));
    const configIO = includeIO(configPath);
    const { snapshot, writeOptions } = await configIO.readConfigFileSnapshotForWrite();
    const nextConfig = enabledPlugin;

    expect(
      resolveIncludeWriteBoundary({
        provenance: snapshot.includeProvenance,
        changed: collectChangedConfigPaths(snapshot.sourceConfig, nextConfig),
      }),
    ).toBeNull();

    await expect(
      replaceConfigFile({
        baseHash: snapshot.hash,
        snapshot,
        writeOptions,
        nextConfig,
        io: {
          readConfigFileSnapshotForWrite: () => configIO.readConfigFileSnapshotForWrite(),
          writeConfigFile: (config, options) => configIO.writeConfigFile(config, options),
        },
      }),
    ).rejects.toThrow("Config write would flatten $include-owned config");

    await expect(fs.readFile(nestedPath, "utf-8")).resolves.toBe(nestedRaw);
    const reloaded = await configIO.readConfigFileSnapshot();
    expect(reloaded.sourceConfig.plugins?.entries?.demo?.enabled).toBe(false);
  });

  it("declines a parent include when both changed children are nested includes", async () => {
    const home = await suiteRootTracker.make("nested-sibling-includes");
    const configPath = path.join(home, ".openclaw", "openclaw.json");
    const entriesPath = path.join(home, ".openclaw", "entries.json5");
    const alphaPath = path.join(home, ".openclaw", "agent-alpha.json5");
    const betaPath = path.join(home, ".openclaw", "agent-beta.json5");
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    const rootRaw = JSON.stringify({ agents: { entries: { $include: "./entries.json5" } } });
    await fs.writeFile(configPath, rootRaw);
    const entriesRaw = JSON.stringify({
      alpha: { $include: "./agent-alpha.json5" },
      beta: { $include: "./agent-beta.json5" },
    });
    await fs.writeFile(entriesPath, entriesRaw);
    const alphaRaw = JSON.stringify({ model: "alpha-old" });
    await fs.writeFile(alphaPath, alphaRaw);
    const betaRaw = JSON.stringify({ model: "beta-old" });
    await fs.writeFile(betaPath, betaRaw);
    const configIO = includeIO(configPath);
    const { snapshot, writeOptions } = await configIO.readConfigFileSnapshotForWrite();
    const nextConfig = structuredClone(snapshot.sourceConfig) as OpenClawConfig;
    nextConfig.agents!.entries!.alpha!.model = "alpha-new";
    nextConfig.agents!.entries!.beta!.model = "beta-new";

    expect(
      resolveIncludeWriteBoundary({
        provenance: snapshot.includeProvenance,
        changed: collectChangedConfigPaths(snapshot.sourceConfig, nextConfig),
      }),
    ).toBeNull();

    await expect(
      replaceConfigFile({
        baseHash: snapshot.hash,
        snapshot,
        writeOptions,
        nextConfig,
        io: {
          readConfigFileSnapshotForWrite: () => configIO.readConfigFileSnapshotForWrite(),
          writeConfigFile: (config, options) => configIO.writeConfigFile(config, options),
        },
      }),
    ).rejects.toThrow("Config write would flatten $include-owned config");

    await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(rootRaw);
    await expect(fs.readFile(entriesPath, "utf-8")).resolves.toBe(entriesRaw);
    await expect(fs.readFile(alphaPath, "utf-8")).resolves.toBe(alphaRaw);
    await expect(fs.readFile(betaPath, "utf-8")).resolves.toBe(betaRaw);
  });

  it("writes through an include beneath a numeric object key", async () => {
    const home = await suiteRootTracker.make("numeric-object-key-include");
    const configPath = path.join(home, ".openclaw", "openclaw.json");
    const guildPath = path.join(home, ".openclaw", "guild.json5");
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(
      configPath,
      JSON.stringify({
        channels: {
          discord: { guilds: { "123456789": { $include: "./guild.json5" } } },
        },
      }),
    );
    await fs.writeFile(guildPath, JSON.stringify({ requireMention: true }));
    const configIO = includeIO(configPath);
    const { snapshot, writeOptions } = await configIO.readConfigFileSnapshotForWrite();
    const nextConfig = structuredClone(snapshot.sourceConfig) as OpenClawConfig;
    nextConfig.channels!.discord!.guilds!["123456789"]!.requireMention = false;
    expect(resolveConfigIncludeWriteBoundary({ snapshot, nextConfig })).toEqual({
      boundaryPath: ["channels", "discord", "guilds", "123456789"],
      includePath: guildPath,
    });

    await replaceConfigFile({
      baseHash: snapshot.hash,
      snapshot,
      writeOptions,
      nextConfig,
      io: {
        readConfigFileSnapshotForWrite: () => configIO.readConfigFileSnapshotForWrite(),
        writeConfigFile: (config, options) => configIO.writeConfigFile(config, options),
      },
    });

    expect(JSON.parse(await fs.readFile(guildPath, "utf-8"))).toEqual({ requireMention: false });
    await expect(fs.readFile(configPath, "utf-8")).resolves.toContain('"$include":"./guild.json5"');
    const reloaded = await configIO.readConfigFileSnapshot();
    expect(reloaded.sourceConfig.channels?.discord?.guilds?.["123456789"]?.requireMention).toBe(
      false,
    );
  });

  it("replaceConfigFile returns the committed snapshot after an external edit", async () => {
    const snapshot = createSnapshot({
      hash: "hash-persisted",
      sourceConfig: { gateway: { auth: { mode: "token" } } },
    });
    const persistedSourceConfig = {
      gateway: { auth: { mode: "token" as const, token: "${TOKEN}" } },
    };
    ioMocks.writeConfigFile.mockResolvedValue({
      persistedSourceConfig,
      persistedHash: "hash-after",
      [configWriteCommittedSnapshot]: {
        hash: "committed-revision",
        sourceConfig: { gateway: { auth: { mode: "token", token: "minted" } } },
      },
      persistedConfig: {
        gateway: { auth: { mode: "token", token: "minted" } },
        meta: { lastTouchedVersion: "test" },
      },
    });
    ioMocks.readConfigFileSnapshotForWrite.mockResolvedValue({
      snapshot: createSnapshot({
        hash: "newer-hash",
        sourceConfig: { gateway: { auth: { mode: "token", token: "newer" } } },
      }),
      writeOptions: {},
    });

    const result = await replaceConfigFile({
      baseHash: snapshot.hash,
      nextConfig: { gateway: { auth: { mode: "token", token: "minted" } } },
      snapshot,
      writeOptions: { expectedConfigPath: snapshot.path },
    });

    expect(result.persistedHash).toBe("committed-revision");
    expect(result.persistedSourceConfig).toBe(persistedSourceConfig);
    expect(result.nextConfig).toEqual({
      gateway: { auth: { mode: "token", token: "minted" } },
    });
  });

  it.each([false, true])(
    "preserves custom-IO include authority through effects (revoked: %s)",
    async (revoke) => {
      const home = await suiteRootTracker.make("custom-include-authority");
      const { configPath, pluginsPath } = await createPluginIncludeFixture(home);
      const includedRaw = '{"entries":{"demo":{"enabled":false}}}\n';
      const backupRaw = "retained include backup\n";
      await fs.writeFile(pluginsPath, includedRaw);
      await fs.writeFile(`${pluginsPath}.bak`, backupRaw);
      const rootRaw = await fs.readFile(configPath, "utf8");
      const selectedPath = path.join(home, "unrelated", "openclaw.json");
      await withEnvAsync({ OPENCLAW_CONFIG_PATH: selectedPath }, async () => {
        const io = createActualConfigIO({
          configPath,
          env: { ...process.env },
          observe: false,
          pluginValidation: "skip",
        });
        const fallbackWrite = vi.fn(io.writeConfigFile);
        const refusal = new Error("custom authority revoked during transform");
        let current = true;
        const assertCurrent = vi.fn(() => {
          if (!current) {
            throw refusal;
          }
        });
        const beforeCommit = vi.fn();
        const operation = mutateConfigFile({
          io: { ...io, writeConfigFile: fallbackWrite },
          writeOptions: {
            assertCurrent,
            beforeCommit,
            observe: false,
            skipPluginValidation: true,
            skipRuntimeSnapshotRefresh: true,
          },
          mutate: async (draft) => {
            await Promise.resolve();
            current = !revoke;
            draft.plugins = { entries: { demo: { enabled: true } } };
          },
        });
        if (revoke) {
          await expect(operation).rejects.toThrow(refusal);
        } else {
          await operation;
        }
        expect(assertCurrent).toHaveBeenCalled();
        expect(fallbackWrite).not.toHaveBeenCalled();
        expect(beforeCommit).toHaveBeenCalledTimes(revoke ? 0 : 1);
        expect(backupMocks.prepareConfigFileWrite).toHaveBeenCalledTimes(revoke ? 0 : 1);
        expect(await fs.readFile(configPath, "utf8")).toBe(rootRaw);
        if (revoke) {
          expect(await fs.readFile(pluginsPath, "utf8")).toBe(includedRaw);
          expect(await fs.readFile(`${pluginsPath}.bak`, "utf8")).toBe(backupRaw);
          await expect(fs.stat(`${pluginsPath}.bak.1`)).rejects.toMatchObject({ code: "ENOENT" });
        } else {
          expect(JSON.parse(await fs.readFile(pluginsPath, "utf8"))).toEqual({
            entries: { demo: { enabled: true } },
          });
          expect(await fs.readFile(`${pluginsPath}.bak`, "utf8")).toBe(includedRaw);
          expect(await fs.readFile(`${pluginsPath}.bak.1`, "utf8")).toBe(backupRaw);
        }
        await expect(fs.stat(path.dirname(selectedPath))).rejects.toMatchObject({ code: "ENOENT" });
      });
    },
  );

  it.each(["foreign-write", "foreign-delete"] as const)(
    "retains reader-owned environment through an include reread: %s",
    async (outcome) => {
      const home = await suiteRootTracker.make("include-env-owner");
      const configPath = path.join(home, "openclaw.json");
      const envPath = path.join(home, "env.json");
      const rootRaw = JSON.stringify({ env: { $include: "./env.json" } });
      const includeRaw = '{"vars":{}}\n';
      await fs.writeFile(configPath, rootRaw);
      await fs.writeFile(envPath, includeRaw);
      const env: NodeJS.ProcessEnv = {
        HOME: home,
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_STATE_DIR: path.join(home, "state"),
        REMOVED: "external",
      };
      let reads = 0;
      let observed: string | undefined;
      const io = createActualConfigIO({
        env,
        observe: false,
        pluginValidation: "skip",
        measure: async (name, run) => {
          if (name === "config.snapshot.read.file") {
            reads += 1;
          }
          const result = await run();
          if (reads === 2 && name === "config.snapshot.read.env") {
            observed = env.OWNED;
            env.ADDED = "external";
            delete env.REMOVED;
            if (outcome === "foreign-write") {
              env.REPLACED = "external";
            } else {
              delete env.REPLACED;
            }
            env.OPENCLAW_CONFIG_PATH = path.join(home, "other.json");
          }
          return result;
        },
      });
      const prepared = await io.readConfigFileSnapshotForWrite();
      const write = replaceConfigFile({
        io,
        snapshot: prepared.snapshot,
        baseHash: prepared.snapshot.hash,
        sourceConfig: {
          ...prepared.snapshot.sourceConfig,
          env: {
            ...prepared.snapshot.sourceConfig.env,
            vars: { OWNED: "candidate", REPLACED: "candidate" },
          },
        },
        writeOptions: {
          ...prepared.writeOptions,
          skipPluginValidation: true,
          assertCurrent: () => {},
        },
      });
      await expect(write).rejects.toMatchObject({
        name: "ConfigWritePostCommitError",
        rollbackStatus: "restored",
      });
      expect(env.OWNED).toBeUndefined();
      expect(env.REPLACED).toBe(outcome === "foreign-write" ? "external" : undefined);
      expect(env.ADDED).toBe("external");
      expect(env.REMOVED).toBeUndefined();
      expect(await fs.readFile(envPath, "utf8")).toBe(includeRaw);
      expect(await fs.readFile(`${envPath}.bak`, "utf8")).toBe(includeRaw);
      expect(observed).toBe("candidate");
      expect(reads).toBe(2);
      expect(await fs.readFile(configPath, "utf8")).toBe(rootRaw);
    },
  );

  it.each([false, true])(
    "forwards custom-IO authority to its own root destination (revoked: %s)",
    async (revoke) => {
      const home = await suiteRootTracker.make("custom-root-authority");
      const configPath = path.join(home, "owned.json");
      const selectedPath = path.join(home, "unrelated", "openclaw.json");
      const original = '{"gateway":{"mode":"local","port":18789}}\n';
      await fs.writeFile(configPath, original);
      await withEnvAsync({ OPENCLAW_CONFIG_PATH: selectedPath }, async () => {
        const io = createActualConfigIO({
          configPath,
          env: { ...process.env },
          observe: false,
          pluginValidation: "skip",
        });
        const refusal = new Error("custom root authority revoked");
        let current = true;
        const assertCurrent = vi.fn(() => {
          if (!current) {
            throw refusal;
          }
        });
        const operation = mutateConfigFile({
          io,
          writeOptions: {
            assertCurrent,
            observe: false,
            skipPluginValidation: true,
            skipRuntimeSnapshotRefresh: true,
          },
          mutate: async (draft) => {
            await Promise.resolve();
            current = !revoke;
            draft.gateway = { ...draft.gateway, port: 19001 };
          },
        });
        if (revoke) {
          await expect(operation).rejects.toBe(refusal);
          expect(await fs.readFile(configPath, "utf8")).toBe(original);
        } else {
          await operation;
          expect(JSON.parse(await fs.readFile(configPath, "utf8")).gateway.port).toBe(19001);
        }
        expect(assertCurrent.mock.calls.length).toBeGreaterThan(1);
        await expect(fs.stat(path.dirname(selectedPath))).rejects.toMatchObject({ code: "ENOENT" });
      });
    },
  );

  registerPluginIncludeReferenceRepairTest({ suiteRootTracker, allowConfigPathWrite, ioMocks });

  it.each(["preflight", "reread"] as const)(
    "preserves delegation ownership when the intermediate file is %s",
    async (changeAt) => {
      const home = await suiteRootTracker.make("nested-include-chain");
      const configPath = path.join(home, "openclaw.json");
      const delegatePath = path.join(home, "delegate.json5");
      const leafPath = path.join(home, "leaf.json5");
      const otherPath = path.join(home, "other.json5");
      const rootRaw = JSON.stringify({ plugins: { $include: "./delegate.json5" } });
      const delegateRaw = JSON.stringify({ $include: "./leaf.json5" });
      const changedDelegateRaw = JSON.stringify({ $include: "./other.json5" });
      const leafRaw = JSON.stringify({ entries: { demo: { enabled: false } } });
      await fs.writeFile(configPath, rootRaw);
      await fs.writeFile(delegatePath, delegateRaw);
      await fs.writeFile(leafPath, leafRaw);
      await fs.writeFile(otherPath, leafRaw);
      const configIO = includeIO(configPath);
      const { snapshot, writeOptions } = await configIO.readConfigFileSnapshotForWrite();
      const nextConfig = structuredClone(snapshot.sourceConfig);
      setConfigValueAtPath(nextConfig, ["plugins", "entries", "demo", "enabled"], true);
      const write = replaceConfigFile({
        snapshot,
        baseHash: snapshot.hash,
        nextConfig,
        writeOptions: {
          ...writeOptions,
          preCommitRuntimePreflight: async () => {
            if (changeAt === "preflight") {
              await fs.writeFile(delegatePath, changedDelegateRaw);
            }
          },
        },
        io: {
          readConfigFileSnapshotForWrite: async () => {
            if (changeAt === "reread") {
              await fs.writeFile(delegatePath, changedDelegateRaw);
            }
            return configIO.readConfigFileSnapshotForWrite();
          },
          writeConfigFile: (config, options) => configIO.writeConfigFile(config, options),
        },
      });
      if (changeAt === "reread") {
        await expect(write).rejects.toBeInstanceOf(Error);
        await expect(write).rejects.not.toBeInstanceOf(ConfigMutationConflictError);
        await expect(write).rejects.toMatchObject({
          name: "ConfigWritePostCommitError",
          configPath: leafPath,
          rollbackStatus: "restored",
          cause: expect.objectContaining({
            name: "ConfigMutationConflictError",
            retryable: true,
          }),
        });
      } else {
        await expect(write).rejects.toThrow(ConfigMutationConflictError);
      }
      await expect(fs.readFile(leafPath, "utf-8")).resolves.toBe(leafRaw);
      await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(rootRaw);
      await expect(fs.readFile(delegatePath, "utf-8")).resolves.toBe(changedDelegateRaw);
      await expect(fs.readFile(otherPath, "utf-8")).resolves.toBe(leafRaw);
    },
  );

  it("writes through a nested include when a read-time migration added keys", async () => {
    const home = await suiteRootTracker.make("nested-include-migrated");
    const configPath = path.join(home, ".openclaw", "openclaw.json");
    const agentPath = path.join(home, ".openclaw", "config", "agent-alpha.json5");
    await fs.mkdir(path.dirname(agentPath), { recursive: true });
    const authoredRoot = {
      agents: { entries: { alpha: { $include: "./config/agent-alpha.json5" } } },
    };
    await fs.writeFile(configPath, json(authoredRoot), "utf-8");
    await fs.writeFile(agentPath, json({ bootstrapMaxChars: 25000 }), "utf-8");
    const migrated = {
      agents: { entries: { alpha: { bootstrapMaxChars: 25000, default: true } } },
    } as OpenClawConfig;
    const nextConfig = {
      agents: { entries: { alpha: { bootstrapMaxChars: 40000, default: true } } },
    } as OpenClawConfig;
    const snapshot: ConfigFileSnapshot = {
      ...createSnapshot({
        hash: "hash-nested-include-migrated",
        path: configPath,
        parsed: authoredRoot,
        sourceConfig: migrated,
      }),
      sourceConfigBeforeMigrations: {
        agents: { entries: { alpha: { bootstrapMaxChars: 25000 } } },
      } as ConfigFileSnapshot["sourceConfigBeforeMigrations"],
      includeProvenance: [
        {
          path: ["agents", "entries", "alpha"],
          kind: "single" as const,
          hasSiblingOverrides: false,
          hasArrayAncestor: false,
          targetPath: agentPath,
        },
      ],
    };
    ioMocks.readConfigFileSnapshotForWrite
      .mockResolvedValueOnce({
        snapshot,
        writeOptions: await includeWriteOptions(snapshot, agentPath),
      })
      .mockResolvedValueOnce(
        readResult(
          createSnapshot({
            hash: "hash-nested-include-migrated-refreshed",
            path: configPath,
            parsed: authoredRoot,
            sourceConfig: nextConfig,
          }),
        ),
      );

    await replaceConfigFile({
      baseHash: snapshot.hash,
      nextConfig,
      writeOptions: { expectedConfigPath: configPath },
      io: ioMocks,
    });

    expect(ioMocks.writeConfigFile).not.toHaveBeenCalled();
    expect(JSON.parse(await fs.readFile(agentPath, "utf-8"))).toEqual({
      bootstrapMaxChars: 40000,
      default: true,
    });
    await expect(fs.readFile(configPath, "utf-8")).resolves.toContain(
      '"$include": "./config/agent-alpha.json5"',
    );
  });

  it.each([
    {
      name: "repairs a malformed single-file top-level include",
      kind: "malformed",
      existing: "{ malformed",
      failure: "parse",
    },
    {
      name: "repairs a missing include whose parent directory is also missing",
      kind: "missing-parent",
      existing: null,
      failure: "read",
    },
  ] as const)("$name", async ({ kind, existing, failure }) => {
    const home = await suiteRootTracker.make(`${kind}-include`);
    const { configPath, pluginsPath } = await createPluginIncludeFixture(home);
    const expectedTarget = await resolveIncludeTarget(pluginsPath);
    if (kind === "missing-parent") {
      await fs.rmdir(path.dirname(pluginsPath));
    }
    if (existing !== null) {
      await fs.writeFile(pluginsPath, existing, "utf-8");
    }
    const snapshot: ConfigFileSnapshot = {
      ...includeSnapshot(configPath, { plugins: {} }),
      valid: false,
      issues: [
        {
          path: "",
          message: `Failed to ${failure} include file: ./config/plugins.json5 (resolved: ${pluginsPath})`,
        },
      ],
    };
    const nextConfig = {
      plugins: { entries: { demo: { enabled: true } } },
    } satisfies OpenClawConfig;
    ioMocks.readConfigFileSnapshotForWrite
      .mockResolvedValueOnce(
        readResult(snapshot, {
          includeFileHashesForWrite: { [pluginsPath]: hashConfigIncludeRaw(existing) },
          assertConfigPathForWrite: allowConfigPathWrite,
          includeFileTargetsForWrite: { [pluginsPath]: expectedTarget },
        }),
      )
      .mockResolvedValueOnce(readResult(includeSnapshot(configPath, nextConfig)));

    await replaceConfigFile({
      baseHash: snapshot.hash,
      nextConfig,
      io: ioMocks,
    });
    expect(ioMocks.writeConfigFile).not.toHaveBeenCalled();
    if (existing !== null) {
      await expect(fs.readFile(`${pluginsPath}.bak`, "utf-8")).resolves.toBe(existing);
    }
    await expect(fs.readFile(pluginsPath, "utf-8")).resolves.toBe(json(nextConfig.plugins));
  });

  it.runIf(process.platform !== "win32")(
    "rejects missing include repairs through symlinked parents outside config roots",
    async () => {
      const home = await suiteRootTracker.make("missing-include-symlink-escape");
      const outside = await suiteRootTracker.make("missing-include-symlink-outside");
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      const linkPath = path.join(home, ".openclaw", "link");
      const pluginsPath = path.join(linkPath, "plugins.json5");
      const outsidePluginsPath = path.join(outside, "plugins.json5");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.symlink(outside, linkPath);
      await fs.writeFile(configPath, json({ plugins: { $include: pluginsPath } }), "utf-8");

      const snapshot: ConfigFileSnapshot = {
        ...createSnapshot({
          hash: "hash-missing-include-symlink-escape",
          path: configPath,
          parsed: { plugins: { $include: pluginsPath } },
          sourceConfig: { plugins: {} },
        }),
        valid: false,
        issues: [
          {
            path: "",
            message: `Failed to read include file: ./link/plugins.json5 (resolved: ${pluginsPath})`,
          },
        ],
      };
      ioMocks.readConfigFileSnapshotForWrite.mockResolvedValue(
        readResult(snapshot, {
          includeFileHashesForWrite: { [pluginsPath]: hashConfigIncludeRaw(null) },
          assertConfigPathForWrite: allowConfigPathWrite,
          includeFileTargetsForWrite: { [pluginsPath]: await resolveIncludeTarget(pluginsPath) },
        }),
      );

      expect(resolveConfigIncludeWriteBoundary({ snapshot, nextConfig: enabledPlugin })).toBeNull();
      await expect(
        replaceConfigFile({
          baseHash: snapshot.hash,
          nextConfig: enabledPlugin,
          io: {
            env: { OPENCLAW_INCLUDE_ROOTS: outside },
            readConfigFileSnapshotForWrite: ioMocks.readConfigFileSnapshotForWrite,
            writeConfigFile: ioMocks.writeConfigFile,
          },
        }),
      ).rejects.toThrow("Config mutation cannot update external $include target");

      await expect(fs.stat(outsidePluginsPath)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("prefers mutation-start include hashes over commit-time reread hashes", async () => {
    const home = await suiteRootTracker.make("include-mutation-start-hash");
    const initialRaw = json({ entries: {} });
    const concurrentRaw = json({ entries: { concurrent: { enabled: true } } });
    const { configPath, pluginsPath } = await createPluginIncludeFixture(home);
    await fs.writeFile(pluginsPath, concurrentRaw, "utf-8");

    const snapshot = includeSnapshot(configPath, {
      plugins: { entries: { concurrent: { enabled: true } } },
    });
    ioMocks.readConfigFileSnapshotForWrite.mockResolvedValue(
      readResult(snapshot, {
        includeFileHashesForWrite: { [pluginsPath]: hashConfigIncludeRaw(concurrentRaw) },
        assertConfigPathForWrite: allowConfigPathWrite,
        includeFileTargetsForWrite: { [pluginsPath]: await resolveIncludeTarget(pluginsPath) },
      }),
    );

    await expect(
      replaceConfigFile({
        baseHash: snapshot.hash,
        writeOptions: {
          expectedConfigPath: configPath,
          includeFileHashesForWrite: { [pluginsPath]: hashConfigIncludeRaw(initialRaw) },
          assertConfigPathForWrite: allowConfigPathWrite,
          includeFileTargetsForWrite: { [pluginsPath]: await resolveIncludeTarget(pluginsPath) },
        },
        nextConfig: enabledPlugin,
        io: ioMocks,
      }),
    ).rejects.toThrow("included config changed since last load");

    expect(ioMocks.writeConfigFile).not.toHaveBeenCalled();
    await expect(fs.readFile(pluginsPath, "utf-8")).resolves.toBe(concurrentRaw);
  });

  it("uses a provided mutation-start snapshot even without write options", async () => {
    const home = await suiteRootTracker.make("include-mutation-start-snapshot");
    const concurrentRaw = json({ entries: { concurrent: { enabled: true } } });
    const { configPath, pluginsPath } = await createPluginIncludeFixture(home);
    await fs.writeFile(pluginsPath, concurrentRaw, "utf-8");

    const snapshot = includeSnapshot(configPath, {
      plugins: { entries: { old: { enabled: true } } },
    });

    await expect(
      replaceConfigFile({
        snapshot,
        baseHash: snapshot.hash,
        nextConfig: enabledPlugin,
        io: ioMocks,
      }),
    ).rejects.toThrow("included config target changed since last load");

    expect(ioMocks.readConfigFileSnapshotForWrite).not.toHaveBeenCalled();
    expect(ioMocks.writeConfigFile).not.toHaveBeenCalled();
    await expect(fs.readFile(pluginsPath, "utf-8")).resolves.toBe(concurrentRaw);
  });

  it("warns before a single-file include write with plugin validation skipped", async () => {
    const home = await suiteRootTracker.make("include-skip-plugin-validation");
    const { configPath, pluginsPath } = await createPluginIncludeFixture(home);
    const pluginsRaw = "{\n  // Keep this plugin note.\n  entries: {},\n}\n";
    await fs.writeFile(pluginsPath, pluginsRaw, "utf-8");
    const snapshot = includeSnapshot(configPath, { plugins: { entries: {} } });
    const refreshedSnapshot = includeSnapshot(configPath, {
      plugins: {
        entries: {
          "strict-plugin": { enabled: true },
        },
      },
    });
    ioMocks.readConfigFileSnapshotForWrite.mockResolvedValue(readResult(refreshedSnapshot));
    const nextConfig: OpenClawConfig = {
      plugins: {
        entries: {
          "strict-plugin": { enabled: true },
        },
      },
    };

    const commentWarnings: string[] = [];
    const warnSpy = vi.spyOn(console, "warn").mockImplementation((message: string) => {
      if (!message.startsWith("Config write will strip JSON5 comments")) {
        return;
      }
      expect(fsNode.readFileSync(pluginsPath, "utf-8")).toBe(pluginsRaw);
      commentWarnings.push(message);
    });
    try {
      await replaceConfigFile({
        baseHash: snapshot.hash,
        snapshot,
        writeOptions: {
          ...(await includeWriteOptions(snapshot, pluginsPath)),
          skipPluginValidation: true,
        },
        nextConfig,
      });
    } finally {
      warnSpy.mockRestore();
    }

    expect(ioMocks.writeConfigFile).not.toHaveBeenCalled();
    expect(commentWarnings).toEqual([
      `Config write will strip JSON5 comments from ${pluginsPath}.`,
    ]);
    expect(validationMocks.validateConfigObjectWithPlugins).toHaveBeenCalledWith(nextConfig, {
      pluginValidation: "skip",
      deferredPluginMigrations: [],
    });
    expect(ioMocks.createConfigIO).toHaveBeenCalledWith({
      configPath,
      pluginValidation: "skip",
      observe: false,
    });
    expect(ioMocks.readConfigFileSnapshotForWrite).toHaveBeenCalledWith();
    await expect(fs.readFile(configPath, "utf-8")).resolves.toContain(
      '"$include": "./config/plugins.json5"',
    );
    const persistedPlugins = JSON.parse(await fs.readFile(pluginsPath, "utf-8")) as {
      entries?: Record<string, unknown>;
    };
    expect(persistedPlugins.entries?.["strict-plugin"]).toEqual({ enabled: true });
    await expect(fs.readFile(`${pluginsPath}.bak`, "utf-8")).resolves.toBe(pluginsRaw);
  });

  it("rejects non-finite numbers before serializing single-file top-level include writes", async () => {
    const { configPath, pluginsPath, initialPluginsRaw, snapshot } =
      await pluginFixture("include-non-finite");

    await expect(
      replaceConfigFile({
        baseHash: snapshot.hash,
        snapshot,
        writeOptions: await includeWriteOptions(snapshot, pluginsPath),
        nextConfig: {
          plugins: {
            entries: {
              demo: { config: { timeout: Infinity } },
            },
          },
        },
      }),
    ).rejects.toThrow("Value must be a finite number, got Infinity");

    await expect(fs.readFile(pluginsPath, "utf-8")).resolves.toBe(initialPluginsRaw);
    await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(
      json({ plugins: { $include: "./config/plugins.json5" } }),
    );
  });

  it("runs a caller commit guard after runtime preflight and before an include write", async () => {
    const { pluginsPath, initialPluginsRaw, snapshot } = await pluginFixture(
      "include-caller-preflight",
    );
    const events: string[] = [];

    try {
      setRuntimeConfigSnapshotRefreshHandler({
        preflight: () => {
          events.push("runtime");
        },
        refresh: () => true,
      });

      await expect(
        replaceConfigFile({
          baseHash: snapshot.hash,
          snapshot,
          writeOptions: {
            ...(await includeWriteOptions(snapshot, pluginsPath)),
            preCommitRuntimePreflight: async (sourceConfig) => {
              events.push(
                `caller:${String(sourceConfig.plugins?.entries?.demo?.enabled ?? false)}`,
              );
              await expect(fs.stat(`${pluginsPath}.bak`)).rejects.toMatchObject({ code: "ENOENT" });
              await expect(fs.readFile(pluginsPath, "utf-8")).resolves.toBe(initialPluginsRaw);
              throw new Error("include authority changed");
            },
          },
          nextConfig: enabledPlugin,
        }),
      ).rejects.toThrow("include authority changed");

      expect(events).toEqual(["runtime", "caller:true"]);
      await expect(fs.readFile(pluginsPath, "utf-8")).resolves.toBe(initialPluginsRaw);
    } finally {
      setRuntimeConfigSnapshotRefreshHandler(null);
    }
  });

  it("uses the published restart env source for isolated managed include writes", async () => {
    const home = await suiteRootTracker.make("include-managed-deferred-restart-env");
    const configPath = path.join(home, ".openclaw", "openclaw.json");
    const envPath = path.join(home, ".openclaw", "config", "env.json5");
    const envKey = "OC";
    await fs.mkdir(path.dirname(envPath), { recursive: true });
    await fs.writeFile(
      configPath,
      json({
        env: { $include: "./config/env.json5" },
        gateway: { auth: { mode: "token", token: "${OC}" } },
      }),
      "utf-8",
    );
    await fs.writeFile(envPath, json({ vars: { [envKey]: "live" } }), "utf-8");
    const initialConfig = {
      env: { vars: { [envKey]: "old" } },
      gateway: { auth: { mode: "token" as const, token: "old" } },
    } satisfies OpenClawConfig;
    const acceptedRestartConfig = {
      env: { vars: { [envKey]: "live" } },
      gateway: { auth: { mode: "token" as const, token: "live" } },
    } satisfies OpenClawConfig;
    const nextConfig = {
      env: { vars: { [envKey]: "next" } },
      gateway: { auth: { mode: "token" as const, token: "live" } },
    } satisfies OpenClawConfig;
    const snapshot = createSnapshot({
      hash: "hash-include-managed-deferred-restart-env",
      path: configPath,
      parsed: {
        env: { $include: "./config/env.json5" },
        gateway: { auth: { mode: "token", token: "${OC}" } },
      },
      sourceConfig: acceptedRestartConfig,
      runtimeConfig: initialConfig,
    });
    const refreshedSnapshot = createSnapshot({
      hash: "hash-include-managed-deferred-restart-env-written",
      path: configPath,
      parsed: snapshot.parsed,
      sourceConfig: {
        ...nextConfig,
        gateway: { auth: { mode: "token", token: "next" } },
      },
    });
    let preflightSource: OpenClawConfig | undefined;
    const releaseOwner = registerManagedRuntimeConfigWriteOwner(
      configPath,
      async (sourceConfig) => {
        preflightSource = sourceConfig;
        return { runtimeConfig: sourceConfig, compareConfig: sourceConfig };
      },
    );
    const previousEnv = process.env[envKey];
    process.env[envKey] = "old";
    setRuntimeConfigSnapshot(initialConfig, initialConfig);
    initializePublishedConfigRuntimeEnv(initialConfig, {
      ownedEnv: { [envKey]: "old" },
    });
    const rollbackRestartEnv = prepareConfigRuntimeEnv({
      previousConfig: initialConfig,
      nextConfig: acceptedRestartConfig,
    }).publish();
    let rereadEnv: NodeJS.ProcessEnv | undefined;
    ioMocks.createConfigIO.mockImplementation((options?: { env?: NodeJS.ProcessEnv }) => ({
      readConfigFileSnapshotForWrite: async () => {
        rereadEnv = options?.env;
        expect(rereadEnv?.[envKey]).toBeUndefined();
        if (rereadEnv) {
          rereadEnv[envKey] = "next";
        }
        return {
          snapshot: refreshedSnapshot,
          writeOptions: { expectedConfigPath: configPath },
        };
      },
    }));

    try {
      await replaceConfigFile({
        baseHash: snapshot.hash,
        snapshot,
        writeOptions: await includeWriteOptions(snapshot, envPath),
        nextConfig,
      });

      expect(rereadEnv).toBeDefined();
      expect(rereadEnv).not.toBe(process.env);
      expect(rereadEnv?.[envKey]).toBe("next");
      expect(preflightSource?.gateway?.auth?.token).toBe("next");
      expect(process.env[envKey]).toBe("live");
    } finally {
      rollbackRestartEnv();
      releaseOwner();
      ioMocks.createConfigIO.mockImplementation(() => ({
        readConfigFileSnapshotForWrite: ioMocks.readConfigFileSnapshotForWrite,
      }));
      if (previousEnv === undefined) {
        delete process.env[envKey];
      } else {
        process.env[envKey] = previousEnv;
      }
    }
  });

  it.each(["include", "root"] as const)(
    "preserves a concurrent %s edit during backup rotation",
    async (target) => {
      const { configPath, pluginsPath, initialPluginsRaw, snapshot } =
        await pluginFixture("include-backup-race");
      const concurrentRaw = json(target === "root" ? enabledPlugin : enabledPlugin.plugins);
      const editedPath = target === "root" ? configPath : pluginsPath;
      backupMocks.prepareConfigFileWrite.mockImplementationOnce(async (params) => {
        const actual =
          await vi.importActual<typeof import("./backup-rotation.js")>("./backup-rotation.js");
        const prepared = await actual.prepareConfigFileWrite(params);
        await fs.writeFile(editedPath, concurrentRaw, "utf-8");
        return prepared;
      });
      await expectPluginIncludeMutationConflict(snapshot, pluginsPath);
      await expect(fs.readFile(editedPath, "utf-8")).resolves.toBe(concurrentRaw);
      if (target === "root") {
        await expect(fs.readFile(pluginsPath, "utf-8")).resolves.toBe(initialPluginsRaw);
      }
    },
  );

  it("rolls back an include write when config path ownership changes during commit", async () => {
    const { configPath, pluginsPath, initialPluginsRaw, snapshot } =
      await pluginFixture("include-commit-owner");
    let activeConfigPath = configPath;
    const assertConfigPathForWrite = () => {
      if (fsNode.readFileSync(pluginsPath, "utf-8") !== initialPluginsRaw) {
        activeConfigPath = "/tmp/other-openclaw.json";
      }
      if (activeConfigPath !== configPath) {
        throw new ConfigMutationConflictError("config path changed since last load", {
          retryable: false,
        });
      }
    };

    const operation = replaceConfigFile({
      baseHash: snapshot.hash,
      snapshot,
      writeOptions: {
        expectedConfigPath: snapshot.path,
        assertConfigPathForWrite,
        includeFileTargetsForWrite: { [pluginsPath]: await resolveIncludeTarget(pluginsPath) },
      },
      nextConfig: enabledPlugin,
    });
    await expect(operation).rejects.toBeInstanceOf(Error);
    await expect(operation).rejects.not.toBeInstanceOf(ConfigMutationConflictError);
    await expect(operation).rejects.toMatchObject({
      name: "ConfigWritePostCommitError",
      configPath: pluginsPath,
      rollbackStatus: "restored",
      cause: expect.objectContaining({
        name: "ConfigMutationConflictError",
        message: "config path changed since last load",
      }),
    });

    await expect(fs.readFile(pluginsPath, "utf-8")).resolves.toBe(initialPluginsRaw);
    await expect(fs.readFile(`${pluginsPath}.bak`, "utf-8")).resolves.toBe(initialPluginsRaw);
    await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(snapshot.raw);
  });

  it("does not retry a committed include write after its post-write read conflicts", async () => {
    const home = await suiteRootTracker.make("include-post-write-retry");
    const { configPath, pluginsPath } = await createPluginIncludeFixture(home);
    const initialPluginsRaw = json({ entries: {} });
    await fs.writeFile(pluginsPath, initialPluginsRaw, "utf-8");
    const concurrentRootRaw = json({
      plugins: { $include: "./config/plugins.json5" },
      logging: { level: "debug" },
    });
    const env = { ...process.env };
    const io = createActualConfigIO({
      configPath,
      env,
      observe: false,
      pluginValidation: "skip",
    });
    let savedRootEdit = false;
    const readConfigFileSnapshotForWrite: ConfigIOReadForWrite = async (options) => {
      if (!savedRootEdit && (await fs.readFile(pluginsPath, "utf-8")) !== initialPluginsRaw) {
        await fs.writeFile(configPath, concurrentRootRaw, "utf-8");
        savedRootEdit = true;
      }
      return await io.readConfigFileSnapshotForWrite(options);
    };
    const transform = vi.fn((config: OpenClawConfig) => ({
      nextConfig: {
        ...config,
        plugins: {
          ...config.plugins,
          entries: { ...config.plugins?.entries, demo: { enabled: true } },
        },
      },
    }));

    const operation = transformConfigFileWithRetry({
      io: { ...io, env, readConfigFileSnapshotForWrite },
      writeOptions: { observe: false, skipPluginValidation: true },
      transform,
    });
    await expect(operation).rejects.toBeInstanceOf(Error);
    await expect(operation).rejects.not.toBeInstanceOf(ConfigMutationConflictError);
    await expect(operation).rejects.toMatchObject({
      name: "ConfigWritePostCommitError",
      configPath: pluginsPath,
      rollbackStatus: "restored",
      cause: expect.objectContaining({
        name: "ConfigMutationConflictError",
        message: "config changed while preparing include write",
      }),
    });
    expect(transform).toHaveBeenCalledOnce();
    await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(concurrentRootRaw);
    await expect(fs.readFile(pluginsPath, "utf-8")).resolves.toBe(initialPluginsRaw);
    await expect(fs.readFile(`${pluginsPath}.bak`, "utf-8")).resolves.toBe(initialPluginsRaw);
    await expect(fs.stat(`${pluginsPath}.bak.1`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.runIf(process.platform !== "win32")(
    "does not create a missing include through a parent symlink swapped during preflight",
    async () => {
      const home = await suiteRootTracker.make("include-preflight-parent-swap");
      const outside = await suiteRootTracker.make("include-preflight-parent-swap-outside");
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      const includeDir = path.join(home, ".openclaw", "config");
      const movedIncludeDir = path.join(home, ".openclaw", "config-original");
      const pluginsPath = path.join(includeDir, "plugins.json5");
      const outsidePluginsPath = path.join(outside, "plugins.json5");
      await fs.mkdir(includeDir, { recursive: true });
      await fs.writeFile(
        configPath,
        json({ plugins: { $include: "./config/plugins.json5" } }),
        "utf-8",
      );
      const snapshot: ConfigFileSnapshot = {
        ...includeSnapshot(configPath, { plugins: {} }),
        valid: false,
        issues: [
          {
            path: "",
            message: `Failed to read include file: ./config/plugins.json5 (resolved: ${pluginsPath})`,
          },
        ],
      };
      ioMocks.readConfigFileSnapshotForWrite.mockResolvedValue(
        readResult(
          includeSnapshot(configPath, {
            plugins: { entries: { demo: { enabled: true } } },
          }),
        ),
      );

      try {
        setRuntimeConfigSnapshotRefreshHandler({
          preflight: async () => {
            await fs.rename(includeDir, movedIncludeDir);
            await fs.symlink(outside, includeDir);
          },
          refresh: () => true,
        });

        await expect(
          replaceConfigFile({
            baseHash: snapshot.hash,
            snapshot,
            writeOptions: {
              expectedConfigPath: configPath,
              includeFileHashesForWrite: { [pluginsPath]: hashConfigIncludeRaw(null) },
              assertConfigPathForWrite: allowConfigPathWrite,
              includeFileTargetsForWrite: {
                [pluginsPath]: await resolveIncludeTarget(pluginsPath),
              },
            },
            nextConfig: enabledPlugin,
            io: ioMocks,
          }),
        ).rejects.toThrow();

        await expect(fs.stat(outsidePluginsPath)).rejects.toMatchObject({ code: "ENOENT" });
        await expect(fs.stat(path.join(movedIncludeDir, "plugins.json5"))).rejects.toMatchObject({
          code: "ENOENT",
        });
      } finally {
        setRuntimeConfigSnapshotRefreshHandler(null);
      }
    },
  );

  registerIncludeReferencePreflightTest({ suiteRootTracker, allowConfigPathWrite, ioMocks });

  it("does not re-substitute resolved root values during include preflight", async () => {
    const home = await suiteRootTracker.make("include-root-escaped-env");
    const configPath = path.join(home, ".openclaw", "openclaw.json");
    const pluginsPath = path.join(home, ".openclaw", "config", "plugins.json5");
    await fs.mkdir(path.dirname(pluginsPath), { recursive: true });
    await fs.writeFile(
      configPath,
      json({
        gateway: { auth: { mode: "token", token: "$${ROOT_LITERAL_TOKEN}" } },
        plugins: { $include: "./config/plugins.json5" },
      }),
      "utf-8",
    );
    await fs.writeFile(pluginsPath, json({ entries: {} }), "utf-8");
    const snapshot = createSnapshot({
      hash: "hash-include-root-escaped-env",
      path: configPath,
      parsed: {
        gateway: { auth: { mode: "token", token: "$${ROOT_LITERAL_TOKEN}" } },
        plugins: { $include: "./config/plugins.json5" },
      },
      sourceConfig: {
        gateway: { auth: { mode: "token", token: "${ROOT_LITERAL_TOKEN}" } },
        plugins: { entries: {} },
      },
    });
    const observedSources: OpenClawConfig[] = [];

    try {
      setRuntimeConfigSnapshotRefreshHandler({
        preflight: ({ sourceConfig }) => {
          observedSources.push(sourceConfig);
          throw new Error("stop before write");
        },
        refresh: () => true,
      });

      await expect(
        replaceConfigFile({
          baseHash: snapshot.hash,
          snapshot,
          writeOptions: await includeWriteOptions(snapshot, pluginsPath),
          nextConfig: {
            gateway: { auth: { mode: "token", token: "${ROOT_LITERAL_TOKEN}" } },
            plugins: { entries: { demo: { enabled: true } } },
          },
          io: {
            env: { ROOT_LITERAL_TOKEN: "secret" },
            readConfigFileSnapshotForWrite: ioMocks.readConfigFileSnapshotForWrite,
            writeConfigFile: ioMocks.writeConfigFile,
          },
        }),
      ).rejects.toThrow(/active SecretRef resolution failed: stop before write/);

      expect(observedSources[0]?.gateway?.auth?.token).toBe("${ROOT_LITERAL_TOKEN}");
    } finally {
      setRuntimeConfigSnapshotRefreshHandler(null);
    }
  });

  it.each(["rename", "permission-fallback"] as const)(
    "rolls back include and environment changes after failed refresh via %s",
    async (method) => {
      const { configPath, pluginsPath, initialPluginsRaw, snapshot } = await pluginFixture(
        "include-runtime-refresh-rollback",
      );
      const env = {} as NodeJS.ProcessEnv;
      const envKey = "OPENCLAW_TEST_INCLUDE_ROLLBACK_ENV";
      mockIncludeRollbackRename(pluginsPath, method);
      const nextConfig = enabledPlugin;
      ioMocks.readConfigFileSnapshotForWrite.mockImplementation(async () => {
        captureConfigReadEnvMutation(env, () =>
          applyConfigEnvVars({ env: { [envKey]: "written-env-value" } }, env),
        );
        return {
          snapshot: includeSnapshot(configPath, nextConfig),
          writeOptions: { expectedConfigPath: configPath },
        };
      });
      const refreshError = new Error("lost include secret");

      try {
        delete env[envKey];
        setRuntimeConfigSnapshotRefreshHandler({
          preflight: () => true,
          refresh: () => {
            throw refreshError;
          },
        });

        const operation = replaceConfigFile({
          baseHash: snapshot.hash,
          snapshot,
          io: { ...ioMocks, env },
          writeOptions: await includeWriteOptions(snapshot, pluginsPath),
          nextConfig,
        });
        await expect(operation).rejects.toBeInstanceOf(Error);
        await expect(operation).rejects.not.toBeInstanceOf(ConfigMutationConflictError);
        await expect(operation).rejects.toMatchObject({
          name: "ConfigWritePostCommitError",
          configPath: pluginsPath,
          rollbackStatus: "restored",
          message: expect.stringMatching(/runtime snapshot refresh failed: lost include secret/),
          cause: expect.objectContaining({ cause: refreshError }),
        });

        await expect(fs.readFile(pluginsPath, "utf-8")).resolves.toBe(initialPluginsRaw);
        await expect(fs.readFile(`${pluginsPath}.bak`, "utf-8")).resolves.toBe(initialPluginsRaw);
        await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(snapshot.raw);
        expect(env[envKey]).toBeUndefined();
      } finally {
        setRuntimeConfigSnapshotRefreshHandler(null);
        delete env[envKey];
      }
    },
  );

  it("does not overwrite concurrent include edits during failed refresh rollback", async () => {
    const { configPath, pluginsPath, initialPluginsRaw, snapshot } = await pluginFixture(
      "include-runtime-refresh-concurrent",
    );
    const concurrentRaw = json({ entries: { concurrent: { enabled: true } } });
    ioMocks.readConfigFileSnapshotForWrite.mockResolvedValue(
      readResult(includeSnapshot(configPath, enabledPlugin)),
    );
    const refreshError = new Error("lost include secret");
    try {
      setRuntimeConfigSnapshotRefreshHandler({
        preflight: () => true,
        refresh: async () => {
          await fs.writeFile(pluginsPath, concurrentRaw, "utf-8");
          throw refreshError;
        },
      });
      const operation = replaceConfigFile({
        baseHash: snapshot.hash,
        snapshot,
        writeOptions: await includeWriteOptions(snapshot, pluginsPath),
        nextConfig: enabledPlugin,
      });
      await expect(operation).rejects.toBeInstanceOf(Error);
      await expect(operation).rejects.not.toBeInstanceOf(ConfigMutationConflictError);
      await expect(operation).rejects.toMatchObject({
        name: "ConfigWritePostCommitError",
        configPath: pluginsPath,
        rollbackStatus: "not-restored",
        message: expect.stringMatching(/runtime snapshot refresh failed: lost include secret/),
        cause: expect.objectContaining({ cause: refreshError }),
      });
      await expect(fs.readFile(pluginsPath, "utf-8")).resolves.toBe(concurrentRaw);
      await expect(fs.readFile(`${pluginsPath}.bak`, "utf-8")).resolves.toBe(initialPluginsRaw);
      await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(snapshot.raw);
    } finally {
      setRuntimeConfigSnapshotRefreshHandler(null);
    }
  });

  it("rejects invalid base config before skipped-plugin include writes", async () => {
    const { pluginsPath, snapshot } = await pluginFixture("include-skip-invalid-base", {
      entries: { old: { enabled: true } },
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
          ...(await includeWriteOptions(snapshot, pluginsPath)),
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

  it("uses the root writer when an include change must persist the roster migration", async () => {
    const home = await suiteRootTracker.make("include-root-write");
    const { configPath, pluginsPath } = await createPluginIncludeFixture(home);
    const parsed = {
      plugins: { $include: "./config/plugins.json5" },
      gateway: { mode: "local" },
      agents: { list: [{ id: "main" }] },
    };
    const sourceConfig: OpenClawConfig = {
      gateway: { mode: "local" },
      plugins: { entries: {} },
      agents: { entries: { main: {} } },
    };
    const snapshot = createSnapshot({
      hash: "hash-multi",
      path: configPath,
      parsed,
      sourceConfig,
    });
    const rootRaw = json(parsed);
    const pluginsRaw = json(sourceConfig.plugins);
    await fs.writeFile(configPath, rootRaw, "utf-8");
    await fs.writeFile(pluginsPath, pluginsRaw, "utf-8");
    ioMocks.readConfigFileSnapshotForWrite.mockResolvedValue(readResult(snapshot));
    const nextConfig: OpenClawConfig = {
      ...sourceConfig,
      gateway: { mode: "local" },
      plugins: { entries: { demo: { enabled: true } } },
    };
    const writeOptions: ConfigWriteOptions = {
      ...(await includeWriteOptions(snapshot, pluginsPath)),
      persistCanonicalAgentRoster: true,
    };
    const refusal = new Error("Root writer refused the combined config mutation");
    ioMocks.writeConfigFile.mockRejectedValueOnce(refusal);

    await expect(replaceConfigFile({ snapshot, writeOptions, nextConfig })).rejects.toBe(refusal);

    expect(ioMocks.writeConfigFile).toHaveBeenCalledOnce();
    expect(ioMocks.writeConfigFile).toHaveBeenCalledWith(nextConfig, {
      baseSnapshot: snapshot,
      ...writeOptions,
      afterWrite: { mode: "auto" },
    });
    await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(rootRaw);
    await expect(fs.readFile(pluginsPath, "utf-8")).resolves.toBe(pluginsRaw);
  });

  it("preflights injected root writers before persisting", async () => {
    const home = await suiteRootTracker.make("injected-root-runtime-preflight");
    const configPath = path.join(home, ".openclaw", "openclaw.json");
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    const initialConfig = { gateway: { mode: "local" } } satisfies OpenClawConfig;
    const initialRaw = json(initialConfig);
    await fs.writeFile(configPath, initialRaw, "utf-8");
    const snapshot = createSnapshot({
      hash: "hash-injected-root",
      path: configPath,
      sourceConfig: initialConfig,
    });
    const nextConfig = {
      gateway: {
        mode: "local",
        auth: {
          mode: "token",
          token: { source: "exec", provider: "execmain", id: "gateway/token" },
        },
      },
    } as OpenClawConfig;
    const injectedWrite = vi.fn(async (config: OpenClawConfig, options?: ConfigWriteOptions) => {
      await options?.preCommitRuntimePreflight?.(config);
      await fs.writeFile(configPath, json(config), "utf-8");
      return { persistedHash: "hash-written", persistedConfig: config };
    });

    try {
      setRuntimeConfigSnapshotRefreshHandler({
        preflight: () => {
          throw new Error("missing root secret");
        },
        refresh: () => true,
      });

      await expect(
        replaceConfigFile({
          snapshot,
          baseHash: snapshot.hash,
          writeOptions: { expectedConfigPath: snapshot.path },
          nextConfig,
          io: {
            readConfigFileSnapshotForWrite: vi.fn(),
            writeConfigFile: injectedWrite,
          },
        }),
      ).rejects.toThrow(/active SecretRef resolution failed: missing root secret/);

      expect(injectedWrite).toHaveBeenCalledTimes(1);
      expect(injectedWrite.mock.calls[0]?.[1]?.preCommitRuntimePreflight).toEqual(
        expect.any(Function),
      );
      await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(initialRaw);
    } finally {
      setRuntimeConfigSnapshotRefreshHandler(null);
    }
  });
});

/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */

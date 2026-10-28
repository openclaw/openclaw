import fsNode from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import * as tmpDirOwner from "../infra/tmp-openclaw-dir.js";
import { createDeferredCore } from "../shared/deferred.js";
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
  includeSnapshot,
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
type IncludeRefusal = {
  name: string;
  files: Record<string, unknown>;
  directory?: string;
  links?: Record<string, string>;
  changes: Array<[string[], unknown]>;
};

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
const pluginInclude = { plugins: { $include: "./config/plugins.json5" } };
const tokenConfig = (token: string): OpenClawConfig => ({
  gateway: { auth: { mode: "token", token } },
});
const snapshotOf = (
  hash: string,
  sourceConfig: OpenClawConfig = {},
  options: Omit<Parameters<typeof createSnapshot>[0], "hash" | "sourceConfig"> = {},
) => createSnapshot({ hash, sourceConfig, ...options });
const agentConfig = (
  entries: NonNullable<OpenClawConfig["agents"]>["entries"] = {},
  ownership?: "explicit",
): OpenClawConfig => ({ agents: { entries, ...(ownership ? { ownership } : {}) } });
function agentSnapshot(
  hash: string,
  entries: Parameters<typeof agentConfig>[0] = {},
  configPath?: string,
) {
  return createSnapshot({ hash, path: configPath, sourceConfig: agentConfig(entries) });
}

function brokenInclude(snapshot: ConfigFileSnapshot, includePath: string, failure = "read") {
  return {
    ...snapshot,
    valid: false,
    issues: [{ path: "", message: `Failed to ${failure} include file: ${includePath}` }],
  };
}

function includeIO(configPath: string, options: Parameters<typeof createActualConfigIO>[0] = {}) {
  return createActualConfigIO({
    env: { ...process.env, OPENCLAW_CONFIG_PATH: configPath },
    observe: false,
    pluginValidation: "skip",
    ...options,
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

async function replaceInclude(
  snapshot: ConfigFileSnapshot,
  includePath: string,
  nextConfig: OpenClawConfig = enabledPlugin,
  writeOptions: ConfigWriteOptions = {},
  io?: Parameters<typeof replaceConfigFile>[0]["io"],
) {
  return replaceConfigFile({
    baseHash: snapshot.hash,
    snapshot,
    writeOptions: { ...(await includeWriteOptions(snapshot, includePath)), ...writeOptions },
    nextConfig,
    io,
  });
}

function replacePrepared(
  snapshot: ConfigFileSnapshot,
  writeOptions: ConfigWriteOptions,
  nextConfig: OpenClawConfig,
  configIO: ReturnType<typeof includeIO>,
) {
  return replaceConfigFile({
    baseHash: snapshot.hash,
    snapshot,
    writeOptions,
    nextConfig,
    io: {
      readConfigFileSnapshotForWrite: () => configIO.readConfigFileSnapshotForWrite(),
      writeConfigFile: (config, options) => configIO.writeConfigFile(config, options),
    },
  });
}

async function expectPostCommitError(operation: Promise<unknown>, details: object) {
  await expect(operation).rejects.toBeInstanceOf(Error);
  await expect(operation).rejects.not.toBeInstanceOf(ConfigMutationConflictError);
  await expect(operation).rejects.toMatchObject({ name: "ConfigWritePostCommitError", ...details });
}

function installRefreshHandler(
  preflight: NonNullable<Parameters<typeof setRuntimeConfigSnapshotRefreshHandler>[0]>["preflight"],
  refresh: NonNullable<
    Parameters<typeof setRuntimeConfigSnapshotRefreshHandler>[0]
  >["refresh"] = () => true,
) {
  setRuntimeConfigSnapshotRefreshHandler({ preflight, refresh });
  onTestFinished(() => setRuntimeConfigSnapshotRefreshHandler(null));
}

describe("config mutate helpers", () => {
  const suiteRootTracker = createSuiteTempRootTracker({ prefix: "openclaw-config-mutate-" });
  const originalNixMode = process.env.OPENCLAW_NIX_MODE;

  async function pluginFixture(
    plugins: NonNullable<OpenClawConfig["plugins"]> = { entries: {} },
    initialPluginsRaw = json(plugins),
  ) {
    const { configPath, pluginsPath } = await createPluginIncludeFixture(
      await suiteRootTracker.make("include"),
    );
    await fs.writeFile(pluginsPath, initialPluginsRaw, "utf-8");
    const snapshot = includeSnapshot(configPath, { plugins });
    return { configPath, pluginsPath, initialPluginsRaw, snapshot };
  }

  async function rawFixture(
    name: string,
    raws: Record<string, string>,
    directory = ".openclaw",
    links: Record<string, string> = {},
  ) {
    const home = await suiteRootTracker.make(name);
    const file = (fileName: string) => path.join(home, directory, fileName);
    for (const [fileName, raw] of Object.entries(raws)) {
      await fs.mkdir(path.dirname(file(fileName)), { recursive: true });
      await fs.writeFile(file(fileName), raw);
    }
    for (const [link, target] of Object.entries(links)) {
      await fs.symlink(file(target), file(link));
    }
    const configPath = file("openclaw.json");
    return { file, raws, configPath };
  }

  async function configFixture(
    name: string,
    files: Record<string, unknown>,
    directory?: string,
    links?: Record<string, string>,
  ) {
    const raws: Record<string, string> = {};
    for (const [fileName, value] of Object.entries(files)) {
      raws[fileName] = JSON.stringify(value);
    }
    const fixture = await rawFixture(name, raws, directory, links);
    const configIO = includeIO(fixture.configPath);
    return { ...fixture, configIO, ...(await configIO.readConfigFileSnapshotForWrite()) };
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

  it("retries transform mutations on stale config conflicts", async () => {
    const initial = agentSnapshot("hash-1");
    const fresh = agentSnapshot("hash-2", { "other-agent": {} });
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
            ...agentConfig({ ...config.agents?.entries, work: {} }, "explicit"),
          },
          result: context.attempt,
        };
      },
    });

    expect(result).toMatchObject({ attempts: 2, result: 1 });
    expect(ioMocks.writeConfigFile).toHaveBeenCalledTimes(2);
    expect(ioMocks.writeConfigFile).toHaveBeenNthCalledWith(
      2,
      agentConfig({ "other-agent": {}, work: {} }, "explicit"),
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
    const initial = agentSnapshot("hash-1", {}, "/tmp/first-openclaw.json");
    const fresh = agentSnapshot("hash-2", {}, "/tmp/second-openclaw.json");
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
    const initial = agentSnapshot("hash-1", {}, configPath);
    const fresh = agentSnapshot("hash-2", { first: {} }, configPath);
    ioMocks.readConfigFileSnapshotForWrite
      .mockResolvedValueOnce(readResult(initial))
      .mockResolvedValue(readResult(fresh));
    ioMocks.writeConfigFile.mockResolvedValue(undefined);

    const started = createDeferredCore();
    const release = createDeferredCore();
    const first = transformConfigFileWithRetry({
      transform: async (config) => {
        started.resolve();
        await release.promise;
        return { nextConfig: { ...config, ...agentConfig({ first: {} }) } };
      },
    });
    await started.promise;
    const second = transformConfigFileWithRetry({
      transform: (config) => ({
        nextConfig: {
          ...config,
          ...agentConfig({ ...config.agents?.entries, second: {} }, "explicit"),
        },
      }),
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(ioMocks.readConfigFileSnapshotForWrite).toHaveBeenCalledTimes(1);

    release.resolve();
    await Promise.all([first, second]);
    expect(ioMocks.writeConfigFile).toHaveBeenNthCalledWith(
      2,
      agentConfig({ first: {}, second: {} }, "explicit"),
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
    const snapshot = snapshotOf("before", {}, { path: resolveConfigPath() });
    const persistedConfig = { ...nextConfig, $include: "extra.json5" };
    ioMocks.readConfigFileSnapshotForWrite.mockResolvedValue(readResult(snapshot));
    ioMocks.writeConfigFile.mockResolvedValue({ persistedHash: "root-only", persistedConfig });
    const result = await replaceConfigFile({ baseHash: snapshot.hash, nextConfig });
    expect([result.persistedHash, result.nextConfig]).toEqual([null, persistedConfig]);
    expect(ioMocks.writeConfigFile).toHaveBeenCalledWith(nextConfig, {
      baseSnapshot: snapshot,
      expectedConfigPath: snapshot.path,
      afterWrite: { mode: "auto" },
    });
  });

  it.each<IncludeRefusal>([
    {
      name: "shared fragment alias in a merged sibling",
      directory: "",
      files: {
        "openclaw.json": {
          plugins: {
            entries: {
              alpha: { $include: "./fragment.json5" },
              beta: { $include: ["./alias.json5"] },
            },
          },
        },
        "fragment.json5": { enabled: false },
      },
      links: { "alias.json5": "fragment.json5" },
      changes: [[["plugins", "entries", "alpha", "enabled"], true]],
    },
    {
      name: "nested delegate shadowed by a same-path include array",
      files: {
        "openclaw.json": { plugins: { $include: ["./delegate.json5", "./override.json5"] } },
        "delegate.json5": { $include: "./nested.json5" },
        "nested.json5": { entries: { demo: { enabled: false } } },
        "override.json5": { entries: { demo: { enabled: false } } },
      },
      changes: [],
    },
    {
      name: "parent include with two nested changed children",
      files: {
        "openclaw.json": { agents: { entries: { $include: "./entries.json5" } } },
        "entries.json5": {
          alpha: { $include: "./alpha.json5" },
          beta: { $include: "./beta.json5" },
        },
        "alpha.json5": { model: "alpha-old" },
        "beta.json5": { model: "beta-old" },
      },
      changes: [
        [["agents", "entries", "alpha", "model"], "alpha-new"],
        [["agents", "entries", "beta", "model"], "beta-new"],
      ],
    },
  ])("refuses flattening $name", async ({ name, files, directory, links, changes }) => {
    const { file, raws, configIO, snapshot, writeOptions } = await configFixture(
      name,
      files,
      directory,
      links,
    );
    const nextConfig = changes.length ? structuredClone(snapshot.sourceConfig) : enabledPlugin;
    for (const [segments, value] of changes) {
      setConfigValueAtPath(nextConfig, segments, value);
    }
    if (links) {
      expect(resolveConfigIncludeWriteBoundary({ snapshot, nextConfig })).toBeNull();
    } else {
      expect(
        resolveIncludeWriteBoundary({
          provenance: snapshot.includeProvenance,
          changed: collectChangedConfigPaths(snapshot.sourceConfig, nextConfig),
        }),
      ).toBeNull();
    }
    await expect(replacePrepared(snapshot, writeOptions, nextConfig, configIO)).rejects.toThrow(
      "Config write would flatten $include-owned config",
    );
    for (const [fileName, raw] of Object.entries(raws)) {
      await expect(fs.readFile(file(fileName), "utf-8")).resolves.toBe(raw);
    }
    const reloaded = (await configIO.readConfigFileSnapshot()).sourceConfig;
    expect(reloaded).toEqual(snapshot.sourceConfig);
    if (!changes.length) {
      expect(reloaded.plugins?.entries?.demo?.enabled).toBe(false);
    }
  });

  it("writes through an include beneath a numeric object key", async () => {
    const { file, configPath, configIO, snapshot, writeOptions } = await configFixture(
      "numeric-object-key-include",
      {
        "openclaw.json": {
          channels: { discord: { guilds: { "123456789": { $include: "./guild.json5" } } } },
        },
        "guild.json5": { requireMention: true },
      },
    );
    const guildPath = file("guild.json5");
    const nextConfig = structuredClone(snapshot.sourceConfig) as OpenClawConfig;
    nextConfig.channels!.discord!.guilds!["123456789"]!.requireMention = false;
    expect(resolveConfigIncludeWriteBoundary({ snapshot, nextConfig })).toEqual({
      boundaryPath: ["channels", "discord", "guilds", "123456789"],
      includePath: guildPath,
    });

    await replacePrepared(snapshot, writeOptions, nextConfig, configIO);

    expect(JSON.parse(await fs.readFile(guildPath, "utf-8"))).toEqual({ requireMention: false });
    await expect(fs.readFile(configPath, "utf-8")).resolves.toContain('"$include":"./guild.json5"');
    const reloaded = await configIO.readConfigFileSnapshot();
    expect(reloaded.sourceConfig.channels?.discord?.guilds?.["123456789"]?.requireMention).toBe(
      false,
    );
  });

  it("replaceConfigFile returns the committed snapshot after an external edit", async () => {
    const snapshot = snapshotOf("hash-persisted", { gateway: { auth: { mode: "token" } } });
    const persistedSourceConfig = tokenConfig("${TOKEN}");
    ioMocks.writeConfigFile.mockResolvedValue({
      persistedSourceConfig,
      persistedHash: "hash-after",
      [configWriteCommittedSnapshot]: {
        hash: "committed-revision",
        sourceConfig: tokenConfig("minted"),
      },
      persistedConfig: {
        ...tokenConfig("minted"),
        meta: { lastTouchedVersion: "test" },
      },
    });
    ioMocks.readConfigFileSnapshotForWrite.mockResolvedValue({
      snapshot: snapshotOf("newer-hash", tokenConfig("newer")),
      writeOptions: {},
    });

    const result = await replaceConfigFile({
      baseHash: snapshot.hash,
      nextConfig: tokenConfig("minted"),
      snapshot,
      writeOptions: { expectedConfigPath: snapshot.path },
    });

    expect([result.persistedHash, result.nextConfig]).toEqual([
      "committed-revision",
      tokenConfig("minted"),
    ]);
    expect(result.persistedSourceConfig).toBe(persistedSourceConfig);
  });

  it.each([
    { kind: "include", revoke: false },
    { kind: "include", revoke: true },
    { kind: "root", revoke: false },
    { kind: "root", revoke: true },
  ])(
    "preserves custom-IO $kind authority through effects (revoked: $revoke)",
    async ({ kind, revoke }) => {
      const home = await suiteRootTracker.make(`custom-${kind}-authority`);
      const include = kind === "include";
      const { configPath: includeRoot, pluginsPath } = await createPluginIncludeFixture(home);
      const configPath = include ? includeRoot : path.join(home, "owned.json");
      const includedRaw = '{"entries":{"demo":{"enabled":false}}}\n';
      const backupRaw = "retained include backup\n";
      if (include) {
        await fs.writeFile(pluginsPath, includedRaw);
        await fs.writeFile(`${pluginsPath}.bak`, backupRaw);
      } else {
        await fs.writeFile(configPath, '{"gateway":{"mode":"local","port":18789}}\n');
      }
      const rootRaw = await fs.readFile(configPath, "utf8");
      const selectedPath = path.join(home, "unrelated", "openclaw.json");
      await withEnvAsync({ OPENCLAW_CONFIG_PATH: selectedPath }, async () => {
        const io = includeIO(configPath, { configPath, env: { ...process.env } });
        const fallbackWrite = vi.fn(io.writeConfigFile);
        const refusal = new Error(`custom ${kind} authority revoked during transform`);
        let current = true;
        const assertCurrent = vi.fn(() => {
          if (!current) {
            throw refusal;
          }
        });
        const beforeCommit = vi.fn();
        const operation = mutateConfigFile({
          io: include ? { ...io, writeConfigFile: fallbackWrite } : io,
          writeOptions: {
            assertCurrent,
            ...(include ? { beforeCommit } : {}),
            observe: false,
            skipPluginValidation: true,
            skipRuntimeSnapshotRefresh: true,
          },
          mutate: async (draft) => {
            await Promise.resolve();
            current = !revoke;
            if (include) {
              draft.plugins = enabledPlugin.plugins;
            } else {
              draft.gateway = { ...draft.gateway, port: 19001 };
            }
          },
        });
        if (revoke) {
          if (include) {
            await expect(operation).rejects.toThrow(refusal);
          } else {
            await expect(operation).rejects.toBe(refusal);
          }
        } else {
          await operation;
        }
        if (include) {
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
            expect(JSON.parse(await fs.readFile(pluginsPath, "utf8"))).toEqual(
              enabledPlugin.plugins,
            );
            expect(await fs.readFile(`${pluginsPath}.bak`, "utf8")).toBe(includedRaw);
            expect(await fs.readFile(`${pluginsPath}.bak.1`, "utf8")).toBe(backupRaw);
          }
        } else {
          expect(assertCurrent.mock.calls.length).toBeGreaterThan(1);
          if (revoke) {
            expect(await fs.readFile(configPath, "utf8")).toBe(rootRaw);
          } else {
            expect(JSON.parse(await fs.readFile(configPath, "utf8")).gateway.port).toBe(19001);
          }
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
      expect({
        OWNED: env.OWNED,
        REPLACED: env.REPLACED,
        ADDED: env.ADDED,
        REMOVED: env.REMOVED,
      }).toMatchObject({
        OWNED: undefined,
        REPLACED: outcome === "foreign-write" ? "external" : undefined,
        ADDED: "external",
        REMOVED: undefined,
      });
      expect(await fs.readFile(envPath, "utf8")).toBe(includeRaw);
      expect(await fs.readFile(`${envPath}.bak`, "utf8")).toBe(includeRaw);
      expect(observed).toBe("candidate");
      expect(reads).toBe(2);
      expect(await fs.readFile(configPath, "utf8")).toBe(rootRaw);
    },
  );

  registerPluginIncludeReferenceRepairTest({ suiteRootTracker, allowConfigPathWrite, ioMocks });

  it.each(["preflight", "reread"] as const)(
    "preserves delegation ownership when the intermediate file is %s",
    async (changeAt) => {
      const { file, raws, configIO, snapshot, writeOptions } = await configFixture(
        "nested-include-chain",
        {
          "openclaw.json": { plugins: { $include: "./delegate.json5" } },
          "delegate.json5": { $include: "./leaf.json5" },
          "leaf.json5": { entries: { demo: { enabled: false } } },
          "other.json5": { entries: { demo: { enabled: false } } },
        },
        "",
      );
      const delegatePath = file("delegate.json5");
      const leafPath = file("leaf.json5");
      const changedDelegateRaw = JSON.stringify({ $include: "./other.json5" });
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
        await expectPostCommitError(write, {
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
      for (const [fileName, raw] of Object.entries({
        ...raws,
        "delegate.json5": changedDelegateRaw,
      })) {
        await expect(fs.readFile(file(fileName), "utf-8")).resolves.toBe(raw);
      }
    },
  );

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
    const snapshot = brokenInclude(
      includeSnapshot(configPath, { plugins: {} }),
      `./config/plugins.json5 (resolved: ${pluginsPath})`,
      failure,
    );
    const nextConfig = enabledPlugin;
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

      const snapshot = brokenInclude(
        snapshotOf(
          "hash-missing-include-symlink-escape",
          { plugins: {} },
          {
            path: configPath,
            parsed: { plugins: { $include: pluginsPath } },
          },
        ),
        `./link/plugins.json5 (resolved: ${pluginsPath})`,
      );
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
    const initialRaw = json({ entries: {} });
    const {
      configPath,
      pluginsPath,
      initialPluginsRaw: concurrentRaw,
      snapshot,
    } = await pluginFixture({
      entries: { concurrent: { enabled: true } },
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
    const concurrentRaw = json({ entries: { concurrent: { enabled: true } } });
    const { pluginsPath, snapshot } = await pluginFixture(
      { entries: { old: { enabled: true } } },
      concurrentRaw,
    );

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
    const pluginsRaw = "{\n  // Keep this plugin note.\n  entries: {},\n}\n";
    const { configPath, pluginsPath, snapshot } = await pluginFixture({ entries: {} }, pluginsRaw);
    const nextConfig: OpenClawConfig = {
      plugins: { entries: { "strict-plugin": { enabled: true } } },
    };
    ioMocks.readConfigFileSnapshotForWrite.mockResolvedValue(
      readResult(includeSnapshot(configPath, nextConfig)),
    );

    const commentWarnings: string[] = [];
    const warnSpy = vi.spyOn(console, "warn").mockImplementation((message: string) => {
      if (!message.startsWith("Config write will strip JSON5 comments")) {
        return;
      }
      expect(fsNode.readFileSync(pluginsPath, "utf-8")).toBe(pluginsRaw);
      commentWarnings.push(message);
    });
    try {
      await replaceInclude(snapshot, pluginsPath, nextConfig, { skipPluginValidation: true });
    } finally {
      warnSpy.mockRestore();
    }

    expect(ioMocks.writeConfigFile).not.toHaveBeenCalled();
    expect(commentWarnings).toEqual([
      `Config write will strip JSON5 comments from ${pluginsPath}.`,
    ]);
    expect(validationMocks.validateConfigObjectWithPlugins).toHaveBeenCalledWith(
      nextConfig,
      expect.objectContaining({ pluginValidation: "skip" }),
    );
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
    const { configPath, pluginsPath, initialPluginsRaw, snapshot } = await pluginFixture();

    await expect(
      replaceInclude(snapshot, pluginsPath, {
        plugins: { entries: { demo: { config: { timeout: Infinity } } } },
      }),
    ).rejects.toThrow("Value must be a finite number, got Infinity");

    await expect(fs.readFile(pluginsPath, "utf-8")).resolves.toBe(initialPluginsRaw);
    await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(json(pluginInclude));
  });

  it("runs a caller commit guard after runtime preflight and before an include write", async () => {
    const { pluginsPath, initialPluginsRaw, snapshot } = await pluginFixture();
    const events: string[] = [];

    installRefreshHandler(() => {
      events.push("runtime");
    });
    await expect(
      replaceInclude(snapshot, pluginsPath, enabledPlugin, {
        preCommitRuntimePreflight: async (sourceConfig) => {
          events.push(`caller:${String(sourceConfig.plugins?.entries?.demo?.enabled ?? false)}`);
          await expect(fs.stat(`${pluginsPath}.bak`)).rejects.toMatchObject({ code: "ENOENT" });
          await expect(fs.readFile(pluginsPath, "utf-8")).resolves.toBe(initialPluginsRaw);
          throw new Error("include authority changed");
        },
      }),
    ).rejects.toThrow("include authority changed");

    expect(events).toEqual(["runtime", "caller:true"]);
    await expect(fs.readFile(pluginsPath, "utf-8")).resolves.toBe(initialPluginsRaw);
  });

  it("uses the published restart env source for isolated managed include writes", async () => {
    const envKey = "OC";
    const parsed = { ...tokenConfig("${OC}"), env: { $include: "./config/env.json5" } };
    const { configPath, file } = await rawFixture("include-managed-deferred-restart-env", {
      "openclaw.json": json(parsed),
      "config/env.json5": json({ vars: { [envKey]: "live" } }),
    });
    const envPath = file("config/env.json5");
    const restartConfig = (value: string, token = value): OpenClawConfig => ({
      ...tokenConfig(token),
      env: { vars: { [envKey]: value } },
    });
    const initialConfig = restartConfig("old");
    const acceptedRestartConfig = restartConfig("live");
    const nextConfig = restartConfig("next", "live");
    const snapshot = snapshotOf(
      "hash-include-managed-deferred-restart-env",
      acceptedRestartConfig,
      {
        path: configPath,
        parsed,
        runtimeConfig: initialConfig,
      },
    );
    const refreshedSnapshot = snapshotOf(
      "hash-include-managed-deferred-restart-env-written",
      restartConfig("next"),
      {
        path: configPath,
        parsed: snapshot.parsed,
      },
    );
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
      await replaceInclude(snapshot, envPath, nextConfig);

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
      const { configPath, pluginsPath, initialPluginsRaw, snapshot } = await pluginFixture();
      const concurrentRaw = json(target === "root" ? enabledPlugin : enabledPlugin.plugins);
      const editedPath = target === "root" ? configPath : pluginsPath;
      backupMocks.prepareConfigFileWrite.mockImplementationOnce(async (params) => {
        const actual =
          await vi.importActual<typeof import("./backup-rotation.js")>("./backup-rotation.js");
        const prepared = await actual.prepareConfigFileWrite(params);
        await fs.writeFile(editedPath, concurrentRaw, "utf-8");
        return prepared;
      });
      await expect(replaceInclude(snapshot, pluginsPath)).rejects.toBeInstanceOf(
        ConfigMutationConflictError,
      );
      await expect(fs.readFile(editedPath, "utf-8")).resolves.toBe(concurrentRaw);
      if (target === "root") {
        await expect(fs.readFile(pluginsPath, "utf-8")).resolves.toBe(initialPluginsRaw);
      }
    },
  );

  it("rolls back an include write when config path ownership changes during commit", async () => {
    const { configPath, pluginsPath, initialPluginsRaw, snapshot } = await pluginFixture();
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

    const operation = replaceInclude(snapshot, pluginsPath, enabledPlugin, {
      assertConfigPathForWrite,
    });
    await expectPostCommitError(operation, {
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
    const { configPath, pluginsPath, initialPluginsRaw } = await pluginFixture();
    const concurrentRootRaw = json({
      plugins: { $include: "./config/plugins.json5" },
      logging: { level: "debug" },
    });
    const env = { ...process.env };
    const io = includeIO(configPath, { configPath, env });
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
    await expectPostCommitError(operation, {
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
      const { configPath, pluginsPath } = await createPluginIncludeFixture(home);
      const includeDir = path.dirname(pluginsPath);
      const movedIncludeDir = path.join(home, ".openclaw", "config-original");
      const outsidePluginsPath = path.join(outside, "plugins.json5");
      const snapshot = brokenInclude(
        includeSnapshot(configPath, { plugins: {} }),
        `./config/plugins.json5 (resolved: ${pluginsPath})`,
      );
      ioMocks.readConfigFileSnapshotForWrite.mockResolvedValue(
        readResult(includeSnapshot(configPath, enabledPlugin)),
      );

      installRefreshHandler(async () => {
        await fs.rename(includeDir, movedIncludeDir);
        await fs.symlink(outside, includeDir);
      });
      await expect(
        replaceInclude(
          snapshot,
          pluginsPath,
          enabledPlugin,
          {
            includeFileHashesForWrite: { [pluginsPath]: hashConfigIncludeRaw(null) },
          },
          ioMocks,
        ),
      ).rejects.toThrow();

      await expect(fs.stat(outsidePluginsPath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.stat(path.join(movedIncludeDir, "plugins.json5"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

  registerIncludeReferencePreflightTest({ suiteRootTracker, allowConfigPathWrite, ioMocks });

  it("does not re-substitute resolved root values during include preflight", async () => {
    const parsed = { ...tokenConfig("$${ROOT_LITERAL_TOKEN}"), ...pluginInclude };
    const { configPath, file } = await rawFixture("include-root-escaped-env", {
      "openclaw.json": json(parsed),
      "config/plugins.json5": json({ entries: {} }),
    });
    const pluginsPath = file("config/plugins.json5");
    const snapshot = snapshotOf(
      "hash-include-root-escaped-env",
      {
        ...tokenConfig("${ROOT_LITERAL_TOKEN}"),
        plugins: { entries: {} },
      },
      { path: configPath, parsed },
    );
    const observedSources: OpenClawConfig[] = [];

    installRefreshHandler(({ sourceConfig }) => {
      observedSources.push(sourceConfig);
      throw new Error("stop before write");
    });
    await expect(
      replaceInclude(
        snapshot,
        pluginsPath,
        { ...tokenConfig("${ROOT_LITERAL_TOKEN}"), ...enabledPlugin },
        {},
        { ...ioMocks, env: { ROOT_LITERAL_TOKEN: "secret" } },
      ),
    ).rejects.toThrow(/active SecretRef resolution failed: stop before write/);

    expect(observedSources[0]?.gateway?.auth?.token).toBe("${ROOT_LITERAL_TOKEN}");
  });

  it.each([false, true])(
    "preserves include rollback ownership after failed refresh (concurrent edit: %s)",
    async (concurrent) => {
      const { configPath, pluginsPath, initialPluginsRaw, snapshot } = await pluginFixture();
      const env: NodeJS.ProcessEnv = {};
      const envKey = "OPENCLAW_TEST_INCLUDE_ROLLBACK_ENV";
      const concurrentRaw = json({ entries: { concurrent: { enabled: true } } });
      const refreshed = readResult(includeSnapshot(configPath, enabledPlugin));
      if (concurrent) {
        ioMocks.readConfigFileSnapshotForWrite.mockResolvedValue(refreshed);
      } else {
        mockIncludeRollbackRename(pluginsPath, "permission-fallback");
        ioMocks.readConfigFileSnapshotForWrite.mockImplementation(async () => {
          captureConfigReadEnvMutation(env, () =>
            applyConfigEnvVars({ env: { [envKey]: "written-env-value" } }, env),
          );
          return refreshed;
        });
      }
      const refreshError = new Error("lost include secret");
      installRefreshHandler(
        () => true,
        async () => {
          if (concurrent) {
            await fs.writeFile(pluginsPath, concurrentRaw, "utf-8");
          }
          throw refreshError;
        },
      );
      onTestFinished(() => {
        delete env[envKey];
      });
      const operation = replaceInclude(
        snapshot,
        pluginsPath,
        enabledPlugin,
        {},
        concurrent ? undefined : { ...ioMocks, env },
      );
      await expectPostCommitError(operation, {
        configPath: pluginsPath,
        rollbackStatus: concurrent ? "not-restored" : "restored",
        message: expect.stringMatching(/runtime snapshot refresh failed: lost include secret/),
        cause: expect.objectContaining({ cause: refreshError }),
      });
      await expect(fs.readFile(pluginsPath, "utf-8")).resolves.toBe(
        concurrent ? concurrentRaw : initialPluginsRaw,
      );
      await expect(fs.readFile(`${pluginsPath}.bak`, "utf-8")).resolves.toBe(initialPluginsRaw);
      await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(snapshot.raw);
      if (!concurrent) {
        expect(env[envKey]).toBeUndefined();
      }
    },
  );

  it("rejects invalid base config before skipped-plugin include writes", async () => {
    const { pluginsPath, snapshot } = await pluginFixture({
      entries: { old: { enabled: true } },
    });
    const nextConfig = {
      plugins: { entries: { "strict-plugin": { enabled: "yes" } } },
    } as unknown as OpenClawConfig;
    validationMocks.validateConfigObjectWithPlugins.mockReturnValue({
      ok: false,
      issues: [{ path: "plugins.entries.strict-plugin.enabled", message: "Expected boolean" }],
      warnings: [],
    });

    await expect(
      replaceInclude(snapshot, pluginsPath, nextConfig, { skipPluginValidation: true }),
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
    const snapshot = snapshotOf("hash-multi", sourceConfig, { path: configPath, parsed });
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
    const initialConfig = { gateway: { mode: "local" } } satisfies OpenClawConfig;
    const initialRaw = json(initialConfig);
    const { configPath } = await rawFixture("injected-root-runtime-preflight", {
      "openclaw.json": initialRaw,
    });
    const snapshot = snapshotOf("hash-injected-root", initialConfig, { path: configPath });
    const nextConfig: OpenClawConfig = {
      gateway: {
        mode: "local",
        auth: {
          mode: "token",
          token: { source: "exec", provider: "execmain", id: "gateway/token" },
        },
      },
    };
    const injectedWrite = vi.fn(async (config: OpenClawConfig, options?: ConfigWriteOptions) => {
      await options?.preCommitRuntimePreflight?.(config);
      await fs.writeFile(configPath, json(config), "utf-8");
      return { persistedHash: "hash-written", persistedConfig: config };
    });

    installRefreshHandler(() => {
      throw new Error("missing root secret");
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
  });
});

/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */

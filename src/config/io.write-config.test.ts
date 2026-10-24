// Covers config write preparation, backup, and persistence behavior.
import fsNode from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { createModelVisibilityPolicy } from "../agents/model-visibility-policy.js";
import { withUpdateCommandExecutor } from "../cli/update-cli/update-command-executor.js";
import * as tmpDirOwner from "../infra/tmp-openclaw-dir.js";
import { captureUpdateDoctorConfigWrites } from "../infra/update-doctor-result.js";
import {
  captureManagedUpdateLeaseDatabaseIdentity,
  createManagedHandoffLeaseDatabase,
} from "../infra/update-managed-service-handoff-database.js";
import { UpdateRequesterRevokedError } from "../infra/update-requester-authority.js";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import { withEnvAsync } from "../test-utils/env.js";
import { initializePublishedConfigRuntimeEnv, prepareConfigRuntimeEnv } from "./config-env-vars.js";
import { withExecutor } from "./config-executor.test-support.js";
import { readLatestConfigSnapshotAuditRecordAsync } from "./config-journal-snapshot.js";
import { getConfigValueAtPath as getAt, setConfigValueAtPath as setAt } from "./config-paths.js";
import { hashConfigIncludeRaw } from "./includes.js";
import { listConfigAuditRecordsForTests } from "./io.audit.test-support.js";
import {
  createConfigIO as createObservedConfigIO,
  getRuntimeConfigSourceSnapshot as sourceSnapshot,
  registerConfigWriteListener,
  resetConfigRuntimeState,
  setRuntimeConfigSnapshot as setSnapshot,
  setRuntimeConfigSnapshotRefreshHandler as setRefreshHandler,
  writeConfigFile,
  type ConfigWriteOptions,
} from "./io.js";
import { hashConfigRaw } from "./io.read-helpers.js";
import { createConfigIoWorkerFixture } from "./io.worker.test-support.js";
import {
  createConfigWriteHomeFixture,
  createConfigWritePluginRegistry as pluginRegistry,
  defaultedDemoPluginRegistry,
} from "./io.write-config.test-support.js";
import { registerConfigWritePreflightTests } from "./io.write-preflight.test-support.js";
import { registerConfigWriteWarningTests } from "./io.write-warnings.test-support.js";
import { replaceConfigFile, transformConfigFile, transformConfigFileWithRetry } from "./mutate.js";
import { ConfigMutationConflictError } from "./mutation-conflict.js";
import { createProviderConfigFixture } from "./runtime-snapshot.test-fixtures.js";
import type { AgentModelEntryConfig, AgentModelPolicyConfig } from "./types.agent-defaults.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "./types.openclaw.js";
import { withConfigWriteLock } from "./write-lock.js";

const CONFIG_CLOBBER_SNAPSHOT_LIMIT = 32;

// Synthetic schemas exercise AJV's write-back defaults (#56772).
const loadRegistry = vi.hoisted(() =>
  vi.fn((): PluginManifestRegistry => ({
    diagnostics: [],
    plugins: [],
  })),
);
const prepareWrite = vi.hoisted(() =>
  vi.fn<typeof import("./backup-rotation.js").prepareConfigFileWrite>(),
);

// mock-isolation: config writes use a synthetic plugin inventory, not installed plugins.
vi.mock("../plugins/manifest-registry.js", () => ({
  loadPluginManifestRegistryCore: loadRegistry,
}));

vi.mock("../plugins/discovery.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugins/discovery.js")>();
  const discovery = { candidates: [], diagnostics: [] };
  return {
    ...actual,
    // The registry above owns this suite's synthetic plugin inventory.
    discoverOpenClawPlugins: () => discovery,
  };
});

vi.mock("../plugins/plugin-registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugins/plugin-registry.js")>();
  return {
    ...actual,
    loadPluginManifestRegistryForPluginRegistry: loadRegistry,
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
  prepareWrite.mockImplementation(actual.prepareConfigFileWrite);
  return {
    ...actual,
    prepareConfigFileWrite: prepareWrite,
  };
});

type ConfigIoOptions = Parameters<typeof createObservedConfigIO>[0];

function createConfigIO(options: ConfigIoOptions = {}) {
  const env = options.env ?? {};
  if (!("NODE_ENV" in env)) {
    // Mark injected environments as tests without adding a key to config env snapshots.
    Object.defineProperty(env, "NODE_ENV", { configurable: true, value: "test" });
  }
  return createObservedConfigIO({
    observe: false,
    ...options,
    env,
  });
}

const suiteRootTracker = createSuiteTempRootTracker({ prefix: "openclaw-config-io-" });
const workers = createConfigIoWorkerFixture();
const silentLogger = {
  warn: () => {},
  error: () => {},
};
const withSuiteHome = createConfigWriteHomeFixture(suiteRootTracker.make);
const cleanups: Array<() => void> = [];

beforeAll(async () => {
  await suiteRootTracker.setup();
  vi.spyOn(tmpDirOwner, "resolvePreferredOpenClawTmpDir").mockReturnValue(
    await suiteRootTracker.make("coordinator"),
  );
  await workers.setup(await suiteRootTracker.make("workers"));
  loadRegistry.mockReturnValue({
    diagnostics: [],
    plugins: [],
  } satisfies PluginManifestRegistry);
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    cleanup();
  }
  setRefreshHandler(null);
  await closeOpenClawStateDatabaseAsync();
  resetConfigRuntimeState();
  loadRegistry.mockReturnValue({ diagnostics: [], plugins: [] });
  prepareWrite.mockReset();
  const actual =
    await vi.importActual<typeof import("./backup-rotation.js")>("./backup-rotation.js");
  prepareWrite.mockImplementation(actual.prepareConfigFileWrite);
});

afterAll(async () => {
  await workers.close();
  closeOpenClawStateDatabaseForTest();
  resetConfigRuntimeState();
  vi.mocked(tmpDirOwner.resolvePreferredOpenClawTmpDir).mockRestore();
  await suiteRootTracker.cleanup();
});

const requireRecord = (value: unknown, label: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`expected ${label} to be a record`);
  }
  return value as Record<string, unknown>;
};

const expectConfigWriteRejected = (promise: Promise<unknown>) =>
  expect(promise).rejects.toHaveProperty("code", "CONFIG_WRITE_REJECTED");

const warnMessages = (warn: ReturnType<typeof vi.fn>): string[] =>
  warn.mock.calls.map(([message]) => String(message));

const homePath = (home: string, fileName = "openclaw.json") =>
  path.join(home, ".openclaw", fileName);
const readRaw = (file: string) => fs.readFile(file, "utf8");
const expectRaw = (file: string, raw: string) => expect(readRaw(file)).resolves.toBe(raw);

const formatConfig = (config: unknown) => `${JSON.stringify(config, null, 2)}\n`;
const gatewayAt = (port: number): OpenClawConfig => ({ gateway: { mode: "local", port } });
const gatewayToken = (token: string): OpenClawConfig => ({
  gateway: { mode: "local", auth: { mode: "token", token } },
});
const pluginEntries = <T>(entries: T) => ({ plugins: { entries } });
const agentEntries = <T>(entries: T) => ({ agents: { entries } });
const agentDefaults = <T>(defaults: T) => ({ agents: { defaults } });

it.each(["changed-input", "revoked-requester"] as const)(
  "refuses Doctor promotion at the native writer (%s)",
  inHome(async (home, failure) => {
    const original: OpenClawConfig = {
      gateway: { mode: "local" },
      tools: { profile: "coding" },
    };
    const raw = formatConfig(original);
    const retained =
      failure === "changed-input"
        ? formatConfig({ ...original, tools: { profile: "minimal" } })
        : raw;
    const { configPath } = await seedRaw(home, retained);
    const io = createConfigIO({ env: { HOME: home }, logger: silentLogger });
    let revoked = false;
    await captureUpdateDoctorConfigWrites(
      configPath,
      async (capture) => {
        const writing = io.writeConfigFile(
          { ...original, tools: { profile: "full" } },
          {
            auditOrigin: "doctor",
            preCommitRuntimePreflight: async () => {
              revoked = true;
            },
          },
        );
        if (failure === "changed-input") {
          await expect(writing).rejects.toThrow("Config changed after update validation");
        } else {
          await expect(writing).rejects.toMatchObject({
            cause: expect.objectContaining({ code: "requester-revoked" }),
          });
        }
        await expectRaw(configPath, retained);
        expect(capture.configChanges).toEqual([]);
      },
      {
        inputHash: hashConfigRaw(raw),
        assertCurrent: () => {
          if (revoked) {
            throw new UpdateRequesterRevokedError();
          }
        },
      },
    );
  }),
);

itWithHome(
  "captures committed Doctor keys including writer metadata without config values",
  async (home) => {
    const original: OpenClawConfig = {
      meta: { lastTouchedVersion: "2026.9.3", migrations: { modelPolicyAllowlist: true } },
      gateway: { mode: "local" },
      tools: { profile: "coding" },
    };
    const { configPath } = await seed(home, original);
    const io = createConfigIO({ env: { HOME: home }, logger: silentLogger });
    await captureUpdateDoctorConfigWrites(
      configPath,
      async (capture) => {
        await io.writeConfigFile(
          { ...original, tools: { profile: "full" } },
          { lastTouchedVersionOverride: "2026.9.4", auditOrigin: "doctor" },
        );
        expect(capture).toMatchObject({
          configChanges: [
            { kind: "key", key: "meta" },
            { kind: "key", key: "tools" },
          ],
        });
        expect(capture.hash).not.toBe("unchanged");
        expect(capture.inputHash).toMatch(/^[0-9a-f]{64}$/u);
        const inputHash = capture.inputHash;
        const next = {
          ...original,
          tools: { profile: "full" as const },
          wizard: { lastRunCommand: "doctor" },
        };
        await io.writeConfigFile(next, {
          lastTouchedVersionOverride: "2026.9.4",
          auditOrigin: "doctor",
        });
        expect(capture.configChanges).toEqual([
          { kind: "key", key: "meta" },
          { kind: "key", key: "tools" },
          { kind: "key", key: "wizard" },
        ]);
        expect(capture.inputHash).toBe(inputHash);
        const committed = structuredClone(capture);
        await expectWriteError(
          io,
          { ...next, gateway: { mode: "remote" } },
          "Write owner changed.",
          {
            beforeCommit: async () => {
              throw new Error("Write owner changed.");
            },
          },
        );
        expect(capture).toMatchObject(committed);
        expect(capture.configWriteRefusal).toMatchObject({ message: "Write owner changed." });
      },
      { inputHash: hashConfigRaw(formatConfig(original)), assertCurrent: () => {} },
    );
  },
);

const existingSnapshot = (
  configPath: string,
  config: OpenClawConfig,
  raw: string | null,
): ConfigFileSnapshot => ({
  path: configPath,
  exists: true,
  raw,
  parsed: config,
  sourceConfig: config,
  resolved: config,
  valid: true,
  runtimeConfig: config,
  config,
  issues: [],
  warnings: [],
  legacyIssues: [],
});

const readConfig = async (configPath: string): Promise<OpenClawConfig> =>
  JSON.parse(await readRaw(configPath)) as OpenClawConfig;

const writeConfigJson = async (configPath: string, config: unknown) => {
  await fs.writeFile(configPath, formatConfig(config), "utf-8");
};

const seed = async (home: string, config: unknown, includes: Record<string, unknown> = {}) => {
  return seedRaw(
    home,
    formatConfig(config),
    Object.fromEntries(
      Object.entries(includes).map(([name, value]) => [name, formatConfig(value)]),
    ),
  );
};

const seedRaw = async (home: string, raw: string, includes: Record<string, string> = {}) => {
  const configPath = homePath(home);
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, raw, "utf-8");
  for (const [name, content] of Object.entries(includes)) {
    await fs.writeFile(homePath(home, name), content, "utf8");
  }
  return { configPath, raw };
};

const homeIO = (home: string, options: ConfigIoOptions = {}) =>
  createConfigIO({ homedir: () => home, logger: silentLogger, ...options });

function itWithHome(name: string, testCase: (home: string) => Promise<void>) {
  it(name, () => withSuiteHome(testCase));
}

const fastIO = (home: string, { env, ...options }: ConfigIoOptions = {}) =>
  homeIO(home, {
    env: { OPENCLAW_TEST_FAST: "1", ...env },
    ...options,
  });

const configFs = (
  overrides: Partial<typeof fsNode> = {},
  promises: Partial<typeof fsNode.promises> = {},
): typeof fsNode => ({ ...fsNode, ...overrides, promises: { ...fsNode.promises, ...promises } });

function inHome<T extends unknown[]>(run: (home: string, ...args: T) => Promise<void>) {
  return (...args: T) => withSuiteHome((home) => run(home, ...args));
}

const expectWriteError = (
  io: Pick<ReturnType<typeof createConfigIO>, "writeConfigFile">,
  config: OpenClawConfig,
  message?: string | RegExp | Error,
  options?: ConfigWriteOptions,
) => expect(io.writeConfigFile(config, options)).rejects.toThrow(message);

const readSnapshot = async (io: ReturnType<typeof createConfigIO>, valid: boolean) => {
  const snapshot = await io.readConfigFileSnapshot();
  expect(snapshot.valid).toBe(valid);
  return snapshot;
};

const withActiveConfig = <T>(
  configPath: string,
  run: () => Promise<T>,
  env: NodeJS.ProcessEnv = {},
) => withEnvAsync({ OPENCLAW_CONFIG_PATH: configPath, ...env }, run);

const auditRecords = (home: string, env: NodeJS.ProcessEnv) =>
  listConfigAuditRecordsForTests({ env, homedir: () => home });

const listen = (...args: Parameters<typeof registerConfigWriteListener>) => {
  cleanups.push(registerConfigWriteListener(...args));
};

const sizeDropConfig = (version: string): OpenClawConfig => ({
  meta: { lastTouchedVersion: version },
  gateway: { mode: "local" },
  channels: {
    telegram: {
      enabled: true,
      allowFrom: Array.from({ length: 80 }, (_, index) => `telegram:${index}`),
    },
  },
});

const policyCases: Array<
  [
    string,
    Record<string, AgentModelEntryConfig>,
    AgentModelPolicyConfig | undefined,
    string[] | null,
  ]
> = [
  ["bare", { bare: {} }, undefined, null],
  ["candidate-marker", { bare: {} }, undefined, ["agents"]],
  ["explicit-allow-any", { bare: {} }, { allow: [] }, ["agents", "defaults", "models"]],
];
it.each(policyCases)(
  "preserves %s policy through its authored source write",
  inHome(async (home, _name, models, modelPolicy, includeAt) => {
    const original = {
      meta: {},
      browser: { enabled: true },
      agents: {
        entries: { main: {} },
        defaults: { models, ...(modelPolicy === undefined ? {} : { modelPolicy }) },
      },
    };
    const include = { $include: "./models.json5" };
    const authored = structuredClone(original);
    const included = includeAt ? getAt(original, includeAt) : undefined;
    if (includeAt?.length) {
      setAt(authored, includeAt, include);
    }
    const { configPath } = await seed(home, authored);
    const includePath = path.join(path.dirname(configPath), "models.json5");
    if (includeAt) {
      await writeConfigJson(includePath, included);
    }
    const io = fastIO(home, { configPath });
    const before = await readSnapshot(io, true);
    const policyFor = (cfg: OpenClawConfig) =>
      createModelVisibilityPolicy({
        cfg,
        catalog: [],
        defaultProvider: "demo",
        agentId: "main",
      });
    const beforePolicy = policyFor(before.config);
    expect(beforePolicy.allowAny).toBe(modelPolicy !== undefined);
    expect(beforePolicy.allows({ provider: "demo", model: "denied" })).toBe(
      modelPolicy !== undefined,
    );
    await io.writeConfigFile({
      ...before.config,
      browser: { enabled: false },
      ...(_name === "candidate-marker"
        ? { meta: { migrations: { modelPolicyAllowlist: true } } }
        : {}),
    });
    const after = await readSnapshot(io, true);
    const afterPolicy = policyFor(after.config);
    expect(afterPolicy.allowAny).toBe(beforePolicy.allowAny);
    expect([...afterPolicy.allowedKeys].toSorted()).toEqual(
      [...beforePolicy.allowedKeys].toSorted(),
    );
    expect(afterPolicy.allows({ provider: "demo", model: "denied" })).toBe(
      beforePolicy.allows({ provider: "demo", model: "denied" }),
    );
    expect(after.sourceConfig.agents?.defaults?.models).toEqual(models);
    expect(after.sourceConfig.browser?.enabled).toBe(false);
    if (includeAt) {
      expect(getAt(await readConfig(configPath), includeAt)).toMatchObject(include);
      await expectRaw(includePath, formatConfig(included));
    }
  }),
);

it.each([
  { field: ["agents", "defaults", "modelPolicy"], value: null },
  { field: ["agents", "defaults"], value: [] },
  { field: ["meta"], value: null },
])(
  "rejects an explicitly malformed $field value $value without writing",
  inHome(async (home, { field, value }) => {
    const original = {
      agents: { entries: { main: {} }, defaults: { models: { "demo/allowed": {} } } },
    };
    const { configPath, raw } = await seed(home, original);
    const io = fastIO(home, { configPath });
    const candidate = structuredClone(original);
    setAt(candidate, field, value);
    await expectWriteError(io, candidate, undefined, {
      explicitSetPaths: [field],
      explicitSetValueSource: candidate,
    });
    await expectRaw(configPath, raw);
  }),
);

for (const [mode, message] of [
  [
    "OPENCLAW_NIX_MODE",
    "Agent-first Nix setup: https://github.com/openclaw/nix-openclaw#quick-start",
  ],
  ["OPENCLAW_CONFIG_READONLY", "Config is externally managed (`OPENCLAW_CONFIG_READONLY=1`)"],
] as const) {
  itWithHome(`refuses direct config writes in ${mode} without changing the file`, async (home) => {
    const { configPath, raw: initialRaw } = await seed(home, {
      env: { vars: { [mode]: "0" } },
      gateway: { mode: "local" },
    });
    const io = fastIO(home, {
      configPath,
      env: { [mode]: "1" },
    });
    expect(io.loadConfig().gateway?.mode).toBe("local");
    expect(io.env[mode]).toBe("1");
    await expectWriteError(io, gatewayAt(19001), message);
    await expectRaw(configPath, initialRaw);
    expect((await io.readConfigFileSnapshot()).config.gateway?.mode).toBe("local");
  });
}

registerConfigWriteWarningTests({
  itWithHome,
  createFastConfigIO: fastIO,
  writeConfigFixture: seed,
});

itWithHome("isolates writes under OPENCLAW_STATE_DIR", async (home) => {
  const { configPath: liveConfigPath } = await seed(home, gatewayAt(18789));
  const overrideDir = path.join(home, "isolated-state");
  const env = { OPENCLAW_STATE_DIR: overrideDir };
  const io = homeIO(home, {
    env,
  });
  expect(io.configPath).toBe(path.join(overrideDir, "openclaw.json"));
  await io.writeConfigFile({
    agents: { entries: { main: {} } },
    gateway: { mode: "local" },
    session: { mainKey: "main", store: path.join(overrideDir, "sessions.json") },
  });
  const livePersisted = await readConfig(liveConfigPath);
  expect(livePersisted.gateway).toEqual({ mode: "local", port: 18789 });
  const overridePersisted = await readConfig(path.join(overrideDir, "openclaw.json"));
  expect(overridePersisted.session?.store).toBe(path.join(overrideDir, "sessions.json"));
});

itWithHome("omits prototype-only config keys", async (home) => {
  const { configPath } = await seed(home, {
    gateway: { mode: "local", port: 18789 },
    commands: { restart: false },
  });
  const io = fastIO(home, { configPath });
  const nextConfig = Object.assign(
    Object.create({ commands: { restart: true } }) as Record<string, unknown>,
    gatewayAt(19001),
  );
  await io.writeConfigFile(nextConfig as OpenClawConfig);
  const persisted = await readConfig(configPath);
  expect(persisted.gateway).toEqual({ mode: "local", port: 19001 });
  expect(Object.hasOwn(persisted, "commands")).toBe(false);
});

const writeAuditCases = [
  {
    name: "logs missing-meta anomalies on request",
    env: { OPENCLAW_TEST_CONFIG_WRITE_LOG: "1" },
    logPrefix: "Config write anomaly:",
    expectedWarnings: ["Config write anomaly:", "missing-meta-before-write"],
  },
  {
    name: "honors skipOutputLogs for overwrite audits",
    env: { VITEST: "true", OPENCLAW_TEST_CONFIG_WRITE_LOG: "1" },
    logPrefix: "Config overwrite:",
    skipOutputLogs: true,
  },
] as const;

for (const auditCase of writeAuditCases) {
  itWithHome(auditCase.name, async (home) => {
    await seed(home, gatewayAt(18789));
    const warn = vi.fn();
    const io = homeIO(home, {
      env: auditCase.env,
      logger: { warn, error: vi.fn() },
    });
    await io.writeConfigFile(
      gatewayAt(18790),
      "skipOutputLogs" in auditCase ? { skipOutputLogs: true } : undefined,
    );
    if ("expectedWarnings" in auditCase) {
      for (const expectedWarning of auditCase.expectedWarnings) {
        expect(warn.mock.calls).toContainEqual([expect.stringContaining(expectedWarning)]);
      }
    } else {
      const auditLogs = warn.mock.calls.filter(
        (call) => typeof call[0] === "string" && call[0].startsWith(auditCase.logPrefix),
      );
      expect(auditLogs).toHaveLength(0);
    }
  });
}

for (const mode of ["OPENCLAW_CONFIG_READONLY", "OPENCLAW_NIX_MODE"]) {
  itWithHome(mode + " preserves prefixed config without recovery snapshots", async (home) => {
    const originalRaw = "status output\n" + formatConfig({ gateway: { mode: "local" } });
    const { configPath } = await seedRaw(home, originalRaw);
    const io = homeIO(home, { env: { VITEST: "true", [mode]: "1" } });
    const snapshot = await readSnapshot(io, false);
    await expect(io.recoverConfigFromJsonRootSuffix(snapshot)).resolves.toBe(false);
    expect(await readRaw(configPath)).toBe(originalRaw);
    expect(
      (await fs.readdir(path.dirname(configPath))).filter((name) => name.includes(".clobbered.")),
    ).toHaveLength(0);
  });
}

for (const failure of ["write", "chmod", "rename"] as const) {
  itWithHome(`prefix recovery preserves the config after a failed ${failure}`, async (home) => {
    const cleanRaw = formatConfig({ gateway: { mode: "local" } });
    const pollutedRaw = `Found and updated: False\n${cleanRaw}`;
    const { configPath } = await seedRaw(home, pollutedRaw);
    const configBasename = path.basename(configPath);
    const originalMode = (await fs.stat(configPath)).mode & 0o777;
    const writeError = Object.assign(new Error(`failed recovery ${failure}`), {
      code: failure === "write" ? "EIO" : "EPERM",
    });
    // Fail publication of the recovered bytes, leaving the original snapshot write intact.
    const stagedHandles = new WeakSet<object>();
    const isStagedConfigTemp = (file: fsNode.PathLike) => {
      const name = path.basename(String(file));
      return name.startsWith(`${configBasename}.`) && name.endsWith(".tmp");
    };
    const crashingFs: typeof fsNode = configFs(
      {},
      {
        open: async (file, ...rest) => {
          const handle = await fsNode.promises.open(file, ...rest);
          if (isStagedConfigTemp(file)) {
            stagedHandles.add(handle);
            if (failure === "chmod") {
              handle.chmod = async () => {
                throw writeError;
              };
            }
          }
          return handle;
        },
        writeFile: async (target, data, options) => {
          const isRecovery =
            typeof target === "string" ? target === configPath : stagedHandles.has(target);
          if (failure === "write" && isRecovery) {
            await fsNode.promises.writeFile(target, "", options);
            throw writeError;
          }
          return fsNode.promises.writeFile(target, data, options);
        },
        rename: async (source, destination) => {
          if (failure === "rename" && destination === configPath) {
            throw writeError;
          }
          return fsNode.promises.rename(source, destination);
        },
      },
    );
    const warn = vi.fn();
    const io = homeIO(home, {
      fs: crashingFs,
      env: { VITEST: "true" },
      logger: { warn, error: vi.fn() },
    });
    const snapshot = await readSnapshot(io, false);
    await expect(io.recoverConfigFromJsonRootSuffix(snapshot)).rejects.toThrow(writeError);
    await expectRaw(configPath, pollutedRaw);
    expect((await fs.stat(configPath)).mode & 0o777).toBe(originalMode);
    expect(warnMessages(warn).join("\n")).not.toContain("Config auto-stripped");
    const files = await fs.readdir(path.dirname(configPath));
    const snapshots = files.filter((file) => file.includes(".clobbered."));
    expect(snapshots).toHaveLength(1);
    await expect(readRaw(path.join(path.dirname(configPath), snapshots[0] ?? ""))).resolves.toBe(
      pollutedRaw,
    );
    expect(files.filter((file) => file.endsWith(".tmp"))).toEqual([]);
  });
}

itWithHome("preserves a shared state root when publishing private config", async (home) => {
  const { configPath } = await seed(home, { gateway: { mode: "local" } });
  const stateDir = path.dirname(configPath);
  await fs.chmod(stateDir, 0o770);
  const io = homeIO(home);
  await io.writeConfigFile(gatewayAt(19001));
  if (process.platform !== "win32") {
    expect((await fs.stat(stateDir)).mode & 0o777).toBe(0o770);
    expect((await fs.stat(configPath)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(`${configPath}.bak`)).mode & 0o777).toBe(0o600);
  }
});

itWithHome("hardens recovered config without pathname chmod", async (home) => {
  const configPath = homePath(home);
  const cleanConfig = {
    gateway: { mode: "local" },
    agents: {
      ownership: "explicit",
      defaults: { systemAgent: { agentId: "main" } },
      entries: { main: {}, "discord-dm": {} },
    },
  } satisfies ConfigFileSnapshot["config"];
  const cleanRaw = formatConfig(cleanConfig);
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.chmod(path.dirname(configPath), 0o770);
  await fs.writeFile(configPath, `Found and updated: False\n${cleanRaw}`, "utf-8");
  await fs.chmod(configPath, 0o644);
  const chmodError = Object.assign(new Error("EPERM: chmod denied"), { code: "EPERM" });
  const warn = vi.fn();
  const chmod = fsNode.promises.chmod.bind(fsNode.promises);
  const io = homeIO(home, {
    fs: configFs(
      {},
      {
        chmod: async (target, mode) => {
          if (target === configPath) {
            throw chmodError;
          }
          return await chmod(target, mode);
        },
      },
    ),
    env: { VITEST: "true" },
    logger: { warn, error: vi.fn() },
  });
  const initialSnapshot = await readSnapshot(io, false);
  await expect(io.recoverConfigFromJsonRootSuffix(initialSnapshot)).resolves.toBe(true);
  await expectRaw(configPath, cleanRaw);
  if (process.platform !== "win32") {
    expect((await fs.stat(configPath)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(path.dirname(configPath))).mode & 0o777).toBe(0o770);
  }
  expect(warnMessages(warn).join("\n")).not.toContain("permission hardening failed");
  expect(warnMessages(warn).join("\n")).toContain(
    `Config auto-stripped non-JSON prefix: ${configPath}`,
  );
});

itWithHome("caps prefix-recovery snapshots in repair loops", async (home) => {
  const configPath = homePath(home);
  const cleanConfig = {
    gateway: { mode: "local" },
    agents: { entries: { main: {} } },
  } satisfies ConfigFileSnapshot["config"];
  const cleanRaw = formatConfig(cleanConfig);
  const warn = vi.fn();
  const io = homeIO(home, {
    env: { VITEST: "true" },
    logger: { warn, error: vi.fn() },
  });
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  for (let index = 0; index < CONFIG_CLOBBER_SNAPSHOT_LIMIT + 4; index++) {
    await fs.writeFile(configPath, `Found and updated: False ${index}\n${cleanRaw}`, "utf-8");
    const snapshot = await readSnapshot(io, false);
    await expect(io.recoverConfigFromJsonRootSuffix(snapshot)).resolves.toBe(true);
  }
  const entries = await fs.readdir(path.dirname(configPath));
  const clobbered = entries.filter((entry) => entry.includes(".clobbered."));
  expect(clobbered).toHaveLength(CONFIG_CLOBBER_SNAPSHOT_LIMIT);
  const clobberedContents = await Promise.all(
    clobbered.map((entry) => readRaw(path.join(path.dirname(configPath), entry))),
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
  await expectRaw(configPath, cleanRaw);
});

it.each(["success", "EEXIST"] as const)(
  "reports the rejected payload save outcome accurately: %s",
  inHome(async (home, outcome) => {
    const original = { gateway: { mode: "local" } } satisfies OpenClawConfig;
    const { configPath, raw: originalRaw } = await seed(home, original);
    const previousPayload = "previous rejected payload\n";
    const warn = vi.fn();
    const io = homeIO(home, {
      env: { VITEST: "true" },
      logger: { warn, error: vi.fn() },
      fs: configFs(
        {},
        {
          writeFile: async (target, data, options) => {
            if (typeof target === "string" && target.includes(".rejected.")) {
              if (outcome === "EEXIST") {
                await fs.writeFile(target, previousPayload);
              }
            }
            return fsNode.promises.writeFile(target, data, options);
          },
        },
      ),
    });
    const baseSnapshot = existingSnapshot(configPath, original, originalRaw);
    const preflight = vi.fn(async () => {
      throw new Error("should not preflight rejected writes");
    });
    let rejection: Record<string, unknown> | undefined;
    try {
      await io.writeConfigFile(
        { update: { channel: "beta" } },
        { baseSnapshot, preCommitRuntimePreflight: preflight },
      );
    } catch (error) {
      rejection = requireRecord(error, "config write rejection");
    }
    expect(rejection).toMatchObject({
      code: "CONFIG_WRITE_REJECTED",
      reasons: ["gateway-mode-removed"],
      message: expect.stringMatching(/Correct the proposed update.+invalid.+doctor --fix/),
    });
    expect(preflight).not.toHaveBeenCalled();
    const audit = auditRecords(home, io.env).find(
      (record) => record.event === "config.write" && record.configPath === configPath,
    );
    expect(audit).toMatchObject({
      result: "rejected",
      errorCode: "CONFIG_WRITE_REJECTED",
      errorMessage: warnMessages(warn)[0],
      nextHash: null,
      nextBytes: null,
    });
    await expectRaw(configPath, originalRaw);
    const artifacts = (await fs.readdir(path.dirname(configPath))).filter((entry) =>
      entry.includes(".rejected."),
    );
    if (outcome === "success") {
      expect(artifacts).toHaveLength(1);
      const savedPath = path.join(path.dirname(configPath), artifacts[0]!);
      expect(rejection).toHaveProperty("rejectedPath", savedPath);
      expect(warnMessages(warn)[0]).toContain(`Rejected payload saved to ${savedPath}.`);
      expect(JSON.parse(await readRaw(savedPath))).toMatchObject({
        update: { channel: "beta" },
      });
    } else {
      expect(rejection).not.toHaveProperty("rejectedPath");
      expect(warnMessages(warn)[0]).toContain("Rejected payload could not be saved to");
      expect(warnMessages(warn)[0]).toContain(outcome);
      expect(warnMessages(warn)[0]).not.toContain("Rejected payload saved to");
      expect(artifacts).toHaveLength(1);
      await expectRaw(path.join(path.dirname(configPath), artifacts[0]!), previousPayload);
    }
  }),
);

itWithHome("ignores BOM spacing, rejects destructive shrinking", async (home) => {
  const original = sizeDropConfig("2026.4.23");
  const powerShellRaw = `\uFEFF${JSON.stringify(original, null, 12)}\n`;
  const { configPath } = await seedRaw(home, powerShellRaw);
  const io = homeIO(home, {
    env: { VITEST: "true" },
  });
  const snapshot = await readSnapshot(io, true);
  await expectConfigWriteRejected(
    io.writeConfigFile(
      { meta: original.meta, gateway: { mode: "local" } },
      { baseSnapshot: snapshot },
    ),
  );
  await expectRaw(configPath, powerShellRaw);
  await io.writeConfigFile(
    {
      ...original,
      gateway: { mode: "local", port: 18789 },
    },
    { baseSnapshot: snapshot },
  );
  const canonicalRaw = await readRaw(configPath);
  expect(Buffer.byteLength(powerShellRaw, "utf-8")).toBeGreaterThan(
    Buffer.byteLength(canonicalRaw, "utf-8") * 2,
  );
});

itWithHome("keeps the raw-byte size baseline for malformed config", async (home) => {
  const malformedRaw = `not-json\n${"x".repeat(2048)}\n`;
  const { configPath } = await seedRaw(home, malformedRaw);
  const io = homeIO(home, {
    env: { VITEST: "true" },
  });
  await expectConfigWriteRejected(io.writeConfigFile({ gateway: { mode: "local" } }));
  await expectRaw(configPath, malformedRaw);
});

itWithHome("allows shrinking without losing mode protection", async (home) => {
  const original = sizeDropConfig("2026.4.30");
  const { configPath, raw: originalRaw } = await seed(home, original);
  const io = homeIO(home, {
    env: { VITEST: "true" },
  });
  const baseSnapshot = existingSnapshot(configPath, original, originalRaw);
  const acceptedWrite = await io.writeConfigFile(
    { meta: original.meta, gateway: { mode: "local" } },
    {
      allowConfigSizeDrop: true,
      baseSnapshot,
    },
  );
  expect(acceptedWrite.persistedConfig.gateway).toEqual({ mode: "local" });
  const acceptedSnapshot = await io.readConfigFileSnapshot();
  await expectConfigWriteRejected(
    io.writeConfigFile(
      { meta: original.meta },
      {
        allowConfigSizeDrop: true,
        baseSnapshot: acceptedSnapshot,
      },
    ),
  );
});

itWithHome("retains read-time env after resolution fails", async (home) => {
  await seed(home, {
    gateway: {
      mode: "local",
      auth: { mode: "token", token: "${OPENCLAW_GATEWAY_TOKEN}" },
    },
    channels: { "test-plugin-channel": { enabled: true } },
  });
  loadRegistry.mockImplementationOnce(() => {
    throw new Error("plugin metadata failed");
  });
  const io = fastIO(home, {
    env: { OPENCLAW_GATEWAY_TOKEN: "gateway-token-at-read" },
  });
  const result = await io.readConfigFileSnapshotForWrite();
  expect(result.snapshot.valid).toBe(false);
  expect(result.writeOptions.envSnapshotForRestore?.OPENCLAW_GATEWAY_TOKEN).toBe(
    "gateway-token-at-read",
  );
});

it.each(["{ malformed", null])(
  "captures include identity at read time: %s",
  inHome(async (home, raw) => {
    const includePath = homePath(home, "plugins.json5");
    await seedRaw(
      home,
      formatConfig({ plugins: { $include: "./plugins.json5" } }),
      raw === null ? {} : { "plugins.json5": raw },
    );
    const result = await fastIO(home).readConfigFileSnapshotForWrite();
    const target =
      raw === null
        ? path.join(await fs.realpath(path.dirname(includePath)), path.basename(includePath))
        : await fs.realpath(includePath);
    if (raw !== null) {
      await fs.writeFile(includePath, "{ differently malformed", "utf-8");
    }
    expect(result.snapshot.valid).toBe(false);
    expect(result.writeOptions.includeFileHashesForWrite?.[includePath]).toBe(
      hashConfigIncludeRaw(raw),
    );
    expect(result.writeOptions.includeFileTargetsForWrite?.[includePath]).toBe(target);
  }),
);

for (const phase of ["read", "write", "retry"] as const) {
  itWithHome(`refuses foreign path ownership during ${phase}`, async (home) => {
    const firstConfigPath = homePath(home, "first.json");
    const secondConfigPath = homePath(home, "second.json");
    const raw =
      phase === "write" ? formatConfig(gatewayAt(18789)) : phase === "read" ? "{}" : "{}\n";
    await fs.mkdir(path.dirname(firstConfigPath), { recursive: true });
    await fs.writeFile(firstConfigPath, raw, "utf8");
    await fs.writeFile(secondConfigPath, raw, "utf8");
    const env = { OPENCLAW_CONFIG_PATH: firstConfigPath, OPENCLAW_TEST_FAST: "1" };
    const io = homeIO(home, { env });
    const priorAudit = auditRecords(home, io.env);
    const callerGuard = vi.fn();
    let pending: Promise<unknown>;
    if (phase === "read") {
      env.OPENCLAW_CONFIG_PATH = secondConfigPath;
      pending = io.readConfigFileSnapshotForWrite();
    } else if (phase === "write") {
      pending = fastIO(home, { configPath: secondConfigPath }).writeConfigFile(gatewayAt(19002), {
        baseSnapshot: await io.readConfigFileSnapshot(),
      });
    } else {
      pending = transformConfigFileWithRetry({
        io,
        transform: () => ({ nextConfig: { gateway: { port: 19001 } } }),
        writeOptions: {
          assertConfigPathForWrite: callerGuard,
          preCommitRuntimePreflight: async () => {
            env.OPENCLAW_CONFIG_PATH = secondConfigPath;
          },
        },
      });
    }
    await expect(pending).rejects.toThrow("config path changed since last load");
    if (phase === "retry") {
      await expect(pending).rejects.toBeInstanceOf(ConfigMutationConflictError);
      await expect(pending).rejects.toHaveProperty("retryable", false);
      expect(callerGuard).toHaveBeenCalled();
      expect(auditRecords(home, io.env)).toEqual(priorAudit);
    }
    await expectRaw(firstConfigPath, raw);
    await expectRaw(secondConfigPath, raw);
  });
}

itWithHome("does not redirect writes to expectedConfigPath", async (home) => {
  const expectedConfigPath = homePath(home, "expected.json");
  const activeConfigPath = homePath(home, "active.json");
  await fs.mkdir(path.dirname(expectedConfigPath), { recursive: true });
  await writeConfigJson(expectedConfigPath, { gateway: { mode: "local" } });
  await fs.writeFile(activeConfigPath, "{}\n", "utf-8");
  await withActiveConfig(
    activeConfigPath,
    () => writeConfigFile({ gateway: { mode: "remote" } }, { expectedConfigPath }),
    { OPENCLAW_TEST_FAST: "1" },
  );
  const expectedConfig = await readConfig(expectedConfigPath);
  const activeConfig = await readConfig(activeConfigPath);
  expect(expectedConfig.gateway?.mode).toBe("local");
  expect(activeConfig.gateway?.mode).toBe("remote");
});

itWithHome("refuses partial writes over a root include", async (home) => {
  const { configPath, raw: originalRaw } = await seedRaw(
    home,
    `{\n  "$include": "./extra.json5",\n  "gateway": { "mode": "local" }\n}\n`,
    { "extra.json5": formatConfig({ $schema: "https://openclaw.ai/config-from-include.json" }) },
  );
  await expect(fastIO(home).writeConfigFile(gatewayAt(18789))).rejects.toThrow(
    "Config write would flatten $include-owned config at <root>",
  );
  await expectRaw(configPath, originalRaw);
});

itWithHome("preserves the other alias of a hardlinked config", async (home) => {
  const { configPath, raw } = await seed(home, gatewayAt(18789));
  const aliasPath = path.join(home, "shared-config.json");
  await fs.link(configPath, aliasPath);
  await fastIO(home).writeConfigFile(gatewayAt(19002));
  expect((await readConfig(configPath)).gateway?.port).toBe(19002);
  await expectRaw(aliasPath, raw);
});

for (const phase of ["preflight", "backup"] as const) {
  itWithHome(`detects root edits during ${phase}`, async (home) => {
    const { configPath } = await seed(home, gatewayAt(18789));
    const io = fastIO(home);
    const snapshot = await io.readConfigFileSnapshot();
    const concurrentRaw = formatConfig(gatewayAt(19001));
    if (phase === "backup") {
      prepareWrite.mockImplementationOnce(async (params) => {
        const actual =
          await vi.importActual<typeof import("./backup-rotation.js")>("./backup-rotation.js");
        const prepared = await actual.prepareConfigFileWrite(params);
        fsNode.writeFileSync(configPath, concurrentRaw, "utf8");
        return prepared;
      });
    }
    await expectWriteError(io, gatewayAt(19002), "config changed since last load", {
      baseSnapshot: snapshot,
      ...(phase === "preflight"
        ? {
            preCommitRuntimePreflight: async () => {
              await fs.writeFile(configPath, concurrentRaw, "utf8");
            },
          }
        : {}),
    });
    if (phase === "preflight") {
      expect(prepareWrite).not.toHaveBeenCalled();
    }
    await expectRaw(configPath, concurrentRaw);
  });
}

for (const existed of [false, true]) {
  itWithHome(
    `detects empty config ${existed ? "removal" : "creation"} during preflight`,
    async (home) => {
      const configPath = homePath(home);
      if (existed) {
        await seedRaw(home, "");
      }
      const io = fastIO(home, { configPath });
      const snapshot = await io.readConfigFileSnapshot();
      expect(snapshot.exists).toBe(existed);
      await expectWriteError(io, gatewayAt(19002), "config changed since last load", {
        baseSnapshot: snapshot,
        preCommitRuntimePreflight: async () => {
          if (existed) {
            await fs.unlink(configPath);
          } else {
            await fs.writeFile(configPath, "", "utf8");
          }
        },
      });
      if (existed) {
        await expect(fs.stat(configPath)).rejects.toMatchObject({ code: "ENOENT" });
      } else {
        await expectRaw(configPath, "");
      }
    },
  );
}

for (const explicit of [false, true]) {
  itWithHome(`persists only explicit rosters on first write: ${explicit}`, async (home) => {
    const configPath = homePath(home);
    const io = fastIO(home, { configPath });
    const snapshot = await io.readConfigFileSnapshot();
    expect(snapshot.exists).toBe(false);
    expect(snapshot.config.agents?.entries).toEqual({ main: {} });
    let preflightConfig: OpenClawConfig | undefined;
    await io.writeConfigFile(
      explicit
        ? snapshot.config
        : {
            ...snapshot.config,
            agents: {
              ...snapshot.config.agents,
              defaults: { model: "claude-cli/claude-opus-4-8" },
            },
          },
      {
        baseSnapshot: snapshot,
        ...(explicit ? { explicitSetPaths: [["agents", "entries"]] } : {}),
        preCommitRuntimePreflight: async (config) => {
          preflightConfig = config;
        },
      },
    );
    expect(preflightConfig?.agents?.entries).toEqual({ main: {} });
    const persisted = await readConfig(configPath);
    if (!explicit) {
      expect(persisted.agents?.defaults?.model).toBe("claude-cli/claude-opus-4-8");
    }
    expect(persisted.agents?.entries).toEqual(explicit ? { main: {} } : undefined);
    expect(persisted.agents).not.toHaveProperty("list");
  });
}

itWithHome("forwards authorized roster removals", async (home) => {
  const { configPath } = await seed(home, {
    agents: {
      ownership: "explicit",
      entries: {
        main: { workspace: "/srv/shared" },
        ops: { workspace: "/srv/shared" },
      },
    },
  });
  await withActiveConfig(
    configPath,
    () =>
      writeConfigFile(
        {
          agents: {
            ownership: "explicit",
            entries: { main: { workspace: "/srv/shared" } },
          },
        },
        { allowedAgentRosterRemovals: ["ops"], skipRuntimeSnapshotRefresh: true },
      ),
    { OPENCLAW_TEST_FAST: "1" },
  );
  const persisted = await readConfig(configPath);
  expect(persisted.agents?.entries).toEqual({
    main: { workspace: "/srv/shared" },
  });
});

for (const section of ["gateway", "plugins"] as const) {
  itWithHome(`refuses flattening invalid ${section} includes`, async (home) => {
    const name = `${section}.json5`;
    const included =
      section === "gateway"
        ? {
            mode: "local",
            auth: { mode: "token", token: "${OPENCLAW_GATEWAY_TOKEN}" },
            invalid: true,
          }
        : { $include: "./missing-entries.json5" };
    const { configPath, raw } = await seed(
      home,
      { [section]: { $include: `./${name}` } },
      { [name]: included },
    );
    const io = fastIO(home, {
      env: section === "gateway" ? { OPENCLAW_GATEWAY_TOKEN: "gateway-token-runtime" } : {},
    });
    await readSnapshot(io, false);
    await expectWriteError(
      io,
      section === "gateway" ? gatewayToken("gateway-token-runtime") : pluginEntries({}),
      `Config write would flatten $include-owned config at ${section}`,
    );
    await expectRaw(configPath, raw);
    await expectRaw(homePath(home, name), formatConfig(included));
  });
}

itWithHome("repairs invalid siblings without flattening", async (home) => {
  const includePath = homePath(home, "agent-defaults.json5");
  const { configPath } = await seed(
    home,
    agentDefaults({ $include: "./agent-defaults.json5", legacyKey: true }),
    { "agent-defaults.json5": { maxConcurrent: 1 } },
  );
  const originalIncludeRaw = await readRaw(includePath);
  const io = fastIO(home);
  await readSnapshot(io, false);
  await io.writeConfigFile(agentDefaults({ maxConcurrent: 1 }));
  const persisted = JSON.parse(await readRaw(configPath)) as {
    agents?: { defaults?: Record<string, unknown> };
  };
  expect(persisted.agents?.defaults).toEqual({ $include: "./agent-defaults.json5" });
  await expectRaw(includePath, originalIncludeRaw);
});

for (const mode of ["local", "leaf-include", "gateway-include"] as const) {
  itWithHome(`preserves gateway ownership during sibling overrides: ${mode}`, async (home) => {
    const gateway =
      mode === "local"
        ? { mode: "${GATEWAY_MODE}" }
        : mode === "leaf-include"
          ? { mode: { $include: "./gateway-mode.json5" } }
          : { $include: "./gateway.json5" };
    const authored = { agents: { $include: "./agents.json5" }, gateway };
    const { configPath, raw } = await seed(home, authored, {
      "agents.json5": { defaults: { workspace: "/srv/old" }, entries: { ops: {} } },
      ...(mode === "leaf-include" ? { "gateway-mode.json5": "local" } : {}),
      ...(mode === "gateway-include" ? { "gateway.json5": { mode: "local" } } : {}),
    });
    const io = mode === "local" ? fastIO(home, { env: { GATEWAY_MODE: "local" } }) : fastIO(home);
    const snapshot = await io.readConfigFileSnapshot();
    const options: ConfigWriteOptions = {
      explicitSetPaths: [["agents", "defaults", "workspace"]],
      explicitSetValueSource: agentDefaults({ workspace: "/srv/next" }),
      allowIncludeAncestorExplicitSetPaths: true,
    };
    if (mode === "leaf-include") {
      await io.writeConfigFile(snapshot.config, options);
      const persisted = await readConfig(configPath);
      expect(persisted).toMatchObject({
        agents: { $include: "./agents.json5", defaults: { workspace: "/srv/next" } },
        gateway,
      });
    } else {
      const writing = io.writeConfigFile({ agents: snapshot.config.agents }, options);
      if (mode === "local") {
        await expectConfigWriteRejected(writing);
        expect(await readConfig(configPath)).toMatchObject(authored);
      } else {
        await expect(writing).rejects.toThrow(
          "Config write would flatten $include-owned config at gateway",
        );
        await expectRaw(configPath, raw);
      }
    }
  });
}

itWithHome("adds root agents without rewriting keyed includes", async (home) => {
  const tonyPath = homePath(home, "tony.json5");
  const tonyRaw = `{
  // Keep operator comments and references byte-identical.
  workspace: "/w/tony",
  model: { primary: "\${TONY_MODEL}" },
}\n`;
  const { configPath } = await seedRaw(
    home,
    formatConfig({
      agents: {
        ownership: "explicit",
        entries: { tony: { $include: "./tony.json5" } },
      },
    }),
    { "tony.json5": tonyRaw },
  );
  const io = fastIO(home, { env: { TONY_MODEL: "openai/gpt-5.4" } });
  const snapshot = await readSnapshot(io, true);
  await io.writeConfigFile({
    ...snapshot.config,
    agents: {
      ...snapshot.config.agents,
      ownership: "explicit",
      entries: {
        ...snapshot.config.agents?.entries,
        worker: { workspace: "/w/worker" },
      },
    },
  });
  const rootAfter = await readConfig(configPath);
  expect(rootAfter.agents?.ownership).toBe("explicit");
  expect(rootAfter.agents?.entries).toEqual({
    tony: { $include: "./tony.json5" },
    worker: { workspace: "/w/worker" },
  });
  await expectRaw(tonyPath, tonyRaw);
});

const keyedIncludeCases: Array<{
  name: string;
  tony: Record<string, unknown>;
  includeFiles: Record<string, string>;
  external?: boolean;
}> = [
  {
    name: "multiple targets",
    tony: { $include: ["./tony-base.json5", "./tony-extra.json5"] },
    includeFiles: {
      ".openclaw/tony-base.json5": `{ workspace: "/w/tony" }\n`,
      ".openclaw/tony-extra.json5": `{ name: "Tony" }\n`,
    },
  },
  {
    name: "root-authored override",
    tony: { $include: "./tony.json5", workspace: "/w/tony" },
    includeFiles: { ".openclaw/tony.json5": `{ name: "Tony" }\n` },
  },
  {
    name: "delegation",
    tony: { $include: "./tony-delegate.json5" },
    includeFiles: {
      ".openclaw/tony-delegate.json5": `{ $include: "./tony.json5" }\n`,
      ".openclaw/tony.json5": `{ workspace: "/w/tony" }\n`,
    },
  },
  {
    name: "external directory",
    tony: { $include: "../shared/tony.json5" },
    includeFiles: { "shared/tony.json5": `{ workspace: "/w/tony" }\n` },
    external: true,
  },
];
for (const { name, tony, includeFiles, external } of keyedIncludeCases) {
  itWithHome(`rejects keyed agent includes with ${name}`, async (home) => {
    const { configPath, raw: rootRaw } = await seed(home, {
      agents: { ownership: "explicit", entries: { tony } },
    });
    for (const [relativePath, raw] of Object.entries(includeFiles)) {
      const includePath = path.join(home, relativePath);
      await fs.mkdir(path.dirname(includePath), { recursive: true });
      await fs.writeFile(includePath, raw, "utf-8");
    }
    const io = fastIO(home, {
      env: external ? { OPENCLAW_INCLUDE_ROOTS: path.join(home, "shared") } : undefined,
    });
    const snapshot = await readSnapshot(io, true);
    await expectWriteError(
      io,
      {
        ...snapshot.config,
        agents: {
          ...snapshot.config.agents,
          ownership: "explicit",
          entries: { ...snapshot.config.agents?.entries, worker: { workspace: "/w/worker" } },
        },
      },
      "Config write would flatten $include-owned config at agents",
    );
    await expectRaw(configPath, rootRaw);
    for (const [relativePath, raw] of Object.entries(includeFiles)) {
      await expectRaw(path.join(home, relativePath), raw);
    }
  });
}

itWithHome("repairs malformed include directives", async (home) => {
  const { configPath } = await seed(home, { plugins: { $include: 42 } });
  const io = fastIO(home);
  await readSnapshot(io, false);
  await io.writeConfigFile({ plugins: {} });
  const persisted = await readConfig(configPath);
  expect(persisted.plugins).toEqual({});
});

itWithHome("rejects non-finite numbers before serialization", async (home) => {
  const { configPath } = await seed(home, pluginEntries({ demo: { enabled: true } }));
  const io = fastIO(home);
  const originalRaw = await readRaw(configPath);
  await expectWriteError(
    io,
    pluginEntries({ demo: { enabled: true, config: { timeout: Infinity } } }),
    "Value must be a finite number, got Infinity",
  );
  await expectRaw(configPath, originalRaw);
});

const literalPluginRegistry = pluginRegistry("literal-plugin", {
  type: "object",
  properties: { token: { type: "string", const: "${ROOT_LITERAL_TOKEN}" } },
  required: ["token"],
  additionalProperties: false,
});

itWithHome("preserves escaped root literals beside includes", async (home) => {
  loadRegistry.mockReturnValue(literalPluginRegistry);
  const { configPath } = await seed(
    home,
    {
      agents: { $include: "./agents.json5" },
      plugins: {
        entries: {
          "literal-plugin": {
            enabled: true,
            config: { token: "$${ROOT_LITERAL_TOKEN}" },
          },
        },
      },
    },
    { "agents.json5": { entries: { main: {} } } },
  );
  const io = fastIO(home, { env: { ROOT_LITERAL_TOKEN: "secret" } });
  const snapshot = await readSnapshot(io, true);
  await io.writeConfigFile({
    ...snapshot.sourceConfig,
    gateway: { mode: "local" },
  });
  await expect(readRaw(configPath)).resolves.toContain('"token": "$${ROOT_LITERAL_TOKEN}"');
});

itWithHome("repairs config without flattening nested entries", async (home) => {
  loadRegistry.mockReturnValue(literalPluginRegistry);
  const includePath = homePath(home, "main-agent.json5");
  const { configPath, raw: originalRootRaw } = await seed(
    home,
    {
      agents: {
        defaults: { params: { stale: true } },
        entries: { main: { $include: "./main-agent.json5" } },
      },
      channels: { "test-plugin-channel": { enabled: true } },
    },
    { "main-agent.json5": { workspace: "${OPENCLAW_AGENT_WORKSPACE}" } },
  );
  const io = fastIO(home, { env: { OPENCLAW_AGENT_WORKSPACE: "/resolved/agent-workspace" } });
  await readSnapshot(io, false);
  await io.writeConfigFile(
    agentEntries({
      main: { workspace: "/resolved/agent-workspace" },
    }),
  );
  await expect(readRaw(configPath)).resolves.not.toBe(originalRootRaw);
  const persistedRoot = await readConfig(configPath);
  expect(persistedRoot.agents?.defaults).toBeUndefined();
  expect(persistedRoot.agents?.entries).toEqual({
    main: { $include: "./main-agent.json5" },
  });
  await expect(readRaw(includePath)).resolves.toContain(
    '"workspace": "${OPENCLAW_AGENT_WORKSPACE}"',
  );
});

itWithHome("rereads managed writes after env transactions", async (home) => {
  const envKey = "OPENCLAW_TEST_INTERLEAVED_WRITE_ENV";
  const makeConfig = (value: string, token: string): OpenClawConfig => ({
    env: { vars: { [envKey]: value } },
    gateway: { mode: "local", auth: { mode: "token", token } },
  });
  const configA = makeConfig("a", "a");
  const authoredA = makeConfig("a", `\${${envKey}}`);
  const configB = makeConfig("b", "a");
  const configC = makeConfig("c", "c");
  const { configPath } = await seed(home, authoredA);
  let notifiedSource: OpenClawConfig | undefined;
  listen(
    (event) => {
      notifiedSource = event.sourceConfig;
    },
    {
      ownsRuntimeActivationFor: configPath,
      preCommitRuntimePreflight: async (sourceConfig) => {
        const staleRuntimeEnv = prepareConfigRuntimeEnv({
          previousConfig: configA,
          nextConfig: sourceConfig,
        });
        await Promise.resolve();
        process.env[envKey] = "c";
        initializePublishedConfigRuntimeEnv(configC, {
          ownedEnv: { [envKey]: "c" },
        });
        return {
          runtimeConfig: sourceConfig,
          compareConfig: sourceConfig,
          runtimeEnv: staleRuntimeEnv,
        };
      },
    },
  );
  await withActiveConfig(
    configPath,
    async () => {
      setSnapshot(configA, configA);
      initializePublishedConfigRuntimeEnv(configA, {
        ownedEnv: { [envKey]: "a" },
      });
      await writeConfigFile(configB);
      expect(notifiedSource?.gateway?.auth?.token).toBe("b");
      expect(process.env[envKey]).toBe("c");
    },
    { [envKey]: "a" },
  );
});

itWithHome("rejects ambiguous env-reference array removals", async (home) => {
  const { configPath, raw: originalRaw } = await seed(home, {
    plugins: { allow: ["${PLUGIN_A}", "${PLUGIN_B}"] },
  });
  const io = fastIO(home, { env: { PLUGIN_A: "same-plugin", PLUGIN_B: "same-plugin" } });
  await expectWriteError(
    io,
    { plugins: { allow: ["same-plugin"] } },
    "Config write would reorder or modify an array",
  );
  await expectRaw(configPath, originalRaw);
});

itWithHome("preserves escaped literals in reordered arrays", async (home) => {
  const { configPath } = await seed(home, {
    plugins: { allow: ["$${PLUGIN_ID}", "literal-plugin"] },
  });
  const io = fastIO(home);
  await io.writeConfigFile({ plugins: { allow: ["literal-plugin", "${PLUGIN_ID}"] } });
  const persisted = await readConfig(configPath);
  expect(persisted.plugins?.allow).toEqual(["literal-plugin", "$${PLUGIN_ID}"]);
});

it.each([null])(
  "rejects invalid full-replacement $schema %s without writing",
  inHome(async (home, value) => {
    const { configPath, raw } = await seed(home, {
      $schema: "https://openclaw.ai/config.json",
      gateway: { mode: "local" },
      plugins: { enabled: false },
    });
    const io = homeIO(home, { configPath });
    const prepared = await io.readConfigFileSnapshotForWrite();
    const next = structuredClone(prepared.snapshot.runtimeConfig);
    setAt(next, ["$schema"], value);
    await expectWriteError(io, next, "$schema", { ...prepared.writeOptions, inputBase: "runtime" });
    expect(await readRaw(configPath)).toBe(raw);
  }),
);

it.each([
  { layout: "include", input: "source", edit: "default" },
  { layout: "include", input: "runtime", edit: "explicit-default" },
  { layout: "include", input: "runtime", edit: "model-unset" },
  { layout: "include", input: "runtime", edit: "array-unset" },
  { layout: "root", input: "runtime", edit: "null-and-omit" },
  { layout: "root", input: "runtime", edit: "policy-unset" },
  { layout: "include", input: "legacy", edit: "active-overlay" },
  { layout: "include", input: "custom-io", edit: "active-overlay" },
] as const)(
  "preserves input intent across $layout $input $edit writes",
  inHome(async (home, { layout, input, edit }) => {
    const prefix = "${INCLUDE_PREFIX}";
    const workspace = "${INCLUDE_WORKSPACE}";
    const legacyModel = "ANTHROPIC/fixture-model";
    const canonicalModel = "anthropic/fixture-model";
    const otherModel = "anthropic/other-model";
    const entry = { alias: "Before", params: { temperature: 0.2 } };
    const otherEntry = { alias: "Keep" };
    const fallbacks = ["anthropic/fixture-a", "anthropic/fixture-b", "anthropic/fixture-c"];
    const defaultsPath = ["agents", "defaults"];
    const temperaturePath = [...defaultsPath, "params", "temperature"];
    const maximumPath = [...defaultsPath, "maxConcurrent"];
    const modelsPath = [...defaultsPath, "models"];
    const fallbacksPath = [...defaultsPath, "model", "fallbacks"];
    const authored: OpenClawConfig = {
      gateway: { mode: "local" },
      plugins: { enabled: false },
      messages: { responsePrefix: prefix },
      agents: {
        ownership: "explicit",
        defaults: {
          systemAgent: { agentId: "probe" },
          workspace,
          params: { temperature: 0.2 },
        },
        entries: { probe: { workspace, identity: { name: "${INCLUDE_NAME}" } } },
      },
    };
    if (edit === "null-and-omit") {
      setAt(authored, [...defaultsPath, "params", "topP"], 0.8);
    } else if (edit === "array-unset") {
      setAt(authored, fallbacksPath, fallbacks);
    } else if (edit === "model-unset") {
      setAt(authored, [...defaultsPath, "modelPolicy"], {});
      setAt(authored, modelsPath, {
        [legacyModel]: entry,
        [otherModel]: otherEntry,
      });
    } else if (edit === "policy-unset") {
      setAt(authored, modelsPath, { [canonicalModel]: entry });
    }
    const include = { $include: "./agents.json" };
    const { configPath } = await seed(
      home,
      layout === "include" ? { ...authored, agents: include } : authored,
    );
    const agentsPath = path.join(path.dirname(configPath), "agents.json");
    if (layout === "include") {
      await writeConfigJson(agentsPath, authored.agents);
    }
    await withActiveConfig(
      configPath,
      async () => {
        const io = homeIO(home, { configPath, env: process.env });
        if (layout === "include") {
          const initial = await readSnapshot(io, true);
          // Keep the native source/runtime difference inside the included section.
          // Otherwise runtime defaults elsewhere select a root write and hide the bug.
          await writeConfigJson(configPath, {
            ...initial.runtimeConfig,
            agents: include,
            messages: { ...initial.runtimeConfig.messages, responsePrefix: prefix },
          });
        }
        const prepared = await io.readConfigFileSnapshotForWrite();
        const { snapshot } = prepared;
        expect(snapshot.valid).toBe(true);
        if (layout === "include") {
          const { agents: sourceAgents, ...sourceRoot } = snapshot.sourceConfig;
          const { agents: runtimeAgents, ...runtimeRoot } = snapshot.runtimeConfig;
          expect(sourceRoot).toStrictEqual(runtimeRoot);
          expect(sourceAgents).not.toStrictEqual(runtimeAgents);
        }
        const originalRoot = await readRaw(configPath);
        const activeRuntime = structuredClone(snapshot.runtimeConfig);
        if (edit === "active-overlay") {
          setAt(activeRuntime, [...defaultsPath, "params", "topP"], 0.9);
        }
        setSnapshot(activeRuntime, snapshot.sourceConfig);
        const maximum = getAt(snapshot.runtimeConfig, maximumPath);
        expect(maximum).toEqual(expect.any(Number));
        const expected = structuredClone(authored);
        if (input === "custom-io") {
          setAt(expected, [...defaultsPath, "params", "topP"], 0.9);
        }
        const writeOptions: ConfigWriteOptions = { ...prepared.writeOptions };
        if (input === "runtime") {
          writeOptions.inputBase = "runtime";
        }
        if (edit === "explicit-default") {
          writeOptions.explicitSetPaths = [maximumPath];
        } else if (edit === "array-unset") {
          writeOptions.unsetPaths = [[...fallbacksPath, "1"]];
          setAt(expected, fallbacksPath, [fallbacks[0], fallbacks[2]]);
        } else if (edit === "model-unset") {
          writeOptions.unsetPaths = [[...modelsPath, canonicalModel]];
          setAt(expected, modelsPath, { [otherModel]: otherEntry });
        } else if (edit === "policy-unset") {
          writeOptions.unsetPaths = [[...defaultsPath, "modelPolicy"]];
        }
        const edited = (config: OpenClawConfig): OpenClawConfig => {
          const next = structuredClone(config);
          if (edit === "active-overlay") {
            setAt(next, temperaturePath, 0.7);
            setAt(expected, temperaturePath, 0.7);
          } else if (edit === "default" || edit === "explicit-default") {
            setAt(next, maximumPath, maximum);
            setAt(expected, maximumPath, maximum);
          } else if (edit === "null-and-omit") {
            setAt(next, temperaturePath, null);
            setAt(expected, temperaturePath, null);
            delete next.agents?.defaults?.params?.topP;
            delete expected.agents?.defaults?.params?.topP;
          }
          return next;
        };
        const base = input === "source" ? snapshot.sourceConfig : activeRuntime;
        await replaceConfigFile({
          ...(input === "source" ? { sourceConfig: edited(base) } : { nextConfig: edited(base) }),
          ...(input === "custom-io" ? { io } : {}),
          snapshot,
          baseHash: snapshot.hash,
          writeOptions,
        });
        const persisted = await readConfig(configPath);
        const savedAgents =
          layout === "include" ? JSON.parse(await readRaw(agentsPath)) : persisted.agents;
        expect(savedAgents).toStrictEqual(expected.agents);
        expect(persisted.messages?.responsePrefix).toBe(prefix);
        if (layout === "include") {
          expect(await readRaw(configPath)).toBe(originalRoot);
          expect(persisted.agents).toStrictEqual(include);
        }
        expect((await io.readConfigFileSnapshot()).valid).toBe(true);
      },
      {
        HOME: home,
        OPENCLAW_HOME: home,
        OPENCLAW_STATE_DIR: path.join(home, ".openclaw"),
        INCLUDE_PREFIX: "[include]",
        INCLUDE_WORKSPACE: path.join(home, "workspace"),
        INCLUDE_NAME: "Included agent",
      },
    );
  }),
);

it.each([
  { layout: "root", caller: "transform", canonicalPresent: false },
  { layout: "include", caller: "replacement", canonicalPresent: true },
] as const)(
  "persists source model renames when active runtime is already canonical ($layout $caller, canonicalPresent: $canonicalPresent)",
  inHome(async (home, { layout, caller, canonicalPresent }) => {
    const entry = { alias: "friendly", params: { temperature: 0.2 } };
    const canonicalEntry = canonicalPresent ? { params: { temperature: 0.7 } } : entry;
    const legacy = "google/gemini-3-pro-preview";
    const canonical = "google/gemini-3.1-pro-preview";
    const agents = {
      entries: { main: {} },
      defaults: {
        models: {
          [legacy]: entry,
          ...(canonicalPresent ? { [canonical]: canonicalEntry } : {}),
        },
      },
    };
    const { configPath } = await seed(home, {
      gateway: { mode: "local" },
      agents: layout === "root" ? agents : { $include: "agents.json" },
    });
    const agentsPath = path.join(path.dirname(configPath), "agents.json");
    if (layout === "include") {
      await writeConfigJson(agentsPath, agents);
    }
    const originalRoot = await readRaw(configPath);
    await withActiveConfig(configPath, async () => {
      const snapshot = await homeIO(home, { configPath }).readConfigFileSnapshot();
      // Exercise the reader's real normalization, not only a manually changed active snapshot.
      expect(Object.keys(snapshot.runtimeConfig.agents?.defaults?.models ?? {})).toEqual([
        canonical,
      ]);
      setSnapshot(snapshot.runtimeConfig, snapshot.sourceConfig);
      const renameModels = (config: OpenClawConfig): OpenClawConfig => ({
        ...config,
        agents: { ...config.agents, defaults: { models: { [canonical]: canonicalEntry } } },
      });
      const result =
        caller === "transform"
          ? await transformConfigFile({
              base: "source",
              transform: (config) => ({ nextConfig: renameModels(config) }),
            })
          : await replaceConfigFile({
              sourceConfig: renameModels(snapshot.sourceConfig),
              baseHash: snapshot.hash,
            });
      const persisted = await readConfig(configPath);
      const savedAgents: OpenClawConfig["agents"] =
        layout === "root" ? persisted.agents : JSON.parse(await readRaw(agentsPath));
      for (const models of [
        savedAgents?.defaults?.models,
        result.nextConfig.agents?.defaults?.models,
        sourceSnapshot()?.agents?.defaults?.models,
      ]) {
        expect(models).toStrictEqual({ [canonical]: canonicalEntry });
      }
      if (layout === "include") {
        expect(await readRaw(configPath)).toBe(originalRoot);
      }
    });
  }),
);

it.each([
  { caller: "live-direct", pluginEntry: "authored-empty" },
  { caller: "mcp-source", pluginEntry: "absent" },
] as const)(
  "preserves $pluginEntry plugin source through two $caller writes and runtime activation",
  inHome(async (home, { caller, pluginEntry }) => {
    loadRegistry.mockReturnValue(defaultedDemoPluginRegistry);
    const initialConfig: OpenClawConfig = {
      ...createProviderConfigFixture(),
      gateway: { mode: "local" },
      agents: { entries: { main: {} } },
      plugins: {
        entries: {
          browser: { enabled: false },
          ...(pluginEntry === "authored-empty" ? { demo: {} } : {}),
        },
      },
      tools: { web: {} },
    };
    const activateRuntime = (config: OpenClawConfig): OpenClawConfig => ({
      ...config,
      ...createProviderConfigFixture("synthetic-runtime-value"),
      plugins: {
        ...config.plugins,
        entries: {
          ...config.plugins?.entries,
          demo: { ...config.plugins?.entries?.demo, enabled: true },
        },
      },
    });
    const observedSources: OpenClawConfig[] = [];
    const expectedSources: OpenClawConfig[] = [];
    listen((event) => {
      observedSources.push(structuredClone(event.sourceConfig));
    });
    const { configPath } = await seed(home, initialConfig);
    await withActiveConfig(configPath, async () => {
      const io = homeIO(home, {
        configPath,
        env: { OPENCLAW_CONFIG_PATH: configPath, VITEST: "true" },
      });
      let prepared = await io.readConfigFileSnapshotForWrite();
      expect(prepared.snapshot.valid).toBe(true);
      expect(prepared.snapshot.sourceConfig.plugins).toStrictEqual(initialConfig.plugins);
      expect(prepared.snapshot.config.plugins?.entries?.demo).toStrictEqual({
        config: { mode: "auto" },
      });
      // Startup activates authored source; hot reload also carries validated defaults.
      let runtimeConfig = activateRuntime(prepared.snapshot.sourceConfig);
      expect(runtimeConfig.plugins?.entries?.demo).toStrictEqual({ enabled: true });
      setSnapshot(runtimeConfig, prepared.snapshot.sourceConfig);
      for (const swarm of [{ enabled: false }, {}]) {
        const base = runtimeConfig;
        const nextConfig: OpenClawConfig = {
          ...base,
          tools: { ...base.tools, swarm },
        };
        if (caller === "mcp-source") {
          const { mcpConfigInternal } = await import("./mcp-config.js");
          const changed = await mcpConfigInternal.set({
            name: "docs",
            server: {
              command: "node",
              args: [swarm.enabled === false ? "first.mjs" : "second.mjs"],
            },
          });
          expect(changed.ok).toBe(true);
          if (changed.ok) {
            expect(changed.config).toEqual(await readConfig(configPath));
          }
        } else {
          await writeConfigFile(nextConfig);
        }
        const persisted = await readConfig(configPath);
        expect(persisted.models?.providers?.openai?.apiKey).toStrictEqual({
          source: "env",
          provider: "default",
          id: "OPENAI_API_KEY",
        });
        expect(persisted.plugins).toStrictEqual(initialConfig.plugins);
        expect(persisted.tools).toStrictEqual(
          caller === "mcp-source" ? initialConfig.tools : { ...initialConfig.tools, swarm },
        );
        prepared = await io.readConfigFileSnapshotForWrite();
        expect(prepared.snapshot.valid).toBe(true);
        expect(prepared.snapshot.sourceConfig.plugins).toStrictEqual(initialConfig.plugins);
        expectedSources.push(prepared.snapshot.sourceConfig);
        expect(observedSources).toStrictEqual(expectedSources);
        expect(sourceSnapshot()).toStrictEqual(prepared.snapshot.sourceConfig);
        expect(prepared.snapshot.config.plugins?.entries?.demo).toStrictEqual({
          config: { mode: "auto" },
        });
        runtimeConfig = activateRuntime(prepared.snapshot.config);
        setSnapshot(runtimeConfig, prepared.snapshot.sourceConfig);
      }
    });
  }),
);

itWithHome("preserves model-command env refs across awaits", async (home) => {
  const { configPath } = await seed(home, gatewayToken("${MODEL_MUTATION_TOKEN}"));
  await withActiveConfig(
    configPath,
    async () => {
      const { updateConfig } = await import("../commands/models/shared.js");
      const updated = await updateConfig(async (config) => {
        expect(config.gateway?.auth?.token).toBe("synthetic-before-mutation");
        await Promise.resolve();
        process.env.MODEL_MUTATION_TOKEN = "synthetic-after-mutation";
        return { ...config, gateway: { ...config.gateway, port: 19002 } };
      });
      expect(updated.gateway?.auth?.token).toBe("synthetic-before-mutation");
      const saved = await readConfig(configPath);
      expect(saved.gateway).toMatchObject({
        auth: { token: "${MODEL_MUTATION_TOKEN}" },
        port: 19002,
      });
    },
    { MODEL_MUTATION_TOKEN: "synthetic-before-mutation" },
  );
});

itWithHome("uses fresh source env refs in runtime transforms", async (home) => {
  const { configPath } = await seed(home, gatewayToken("${TOKEN_B}"));
  await withActiveConfig(
    configPath,
    async () => {
      const snapshot = await homeIO(home, {
        configPath,
        env: process.env,
      }).readConfigFileSnapshot();
      expect(snapshot.runtimeConfig.gateway?.auth?.token).toBe("synthetic-same-token");
      setSnapshot(snapshot.runtimeConfig, {
        ...snapshot.sourceConfig,
        gateway: {
          ...snapshot.sourceConfig.gateway,
          auth: { mode: "token", token: "${TOKEN_A}" },
        },
      });
      await transformConfigFile({
        base: "runtime",
        transform: (config) => ({
          nextConfig: { ...config, gateway: { ...config.gateway, port: 19002 } },
        }),
      });
      const saved = await readConfig(configPath);
      expect(saved.gateway).toMatchObject({ auth: { token: "${TOKEN_B}" }, port: 19002 });
    },
    { TOKEN_A: "synthetic-same-token", TOKEN_B: "synthetic-same-token" },
  );
});

it.each(["snapshot-runtime"] as const)(
  "preserves an intentional %s edit equal to a stale active source value",
  inHome(async (home) => {
    const { configPath } = await seed(home, {
      gateway: { mode: "local" },
      logging: { level: "warn" },
    });
    await withActiveConfig(configPath, async () => {
      const io = homeIO(home, { configPath });
      const prepared = await io.readConfigFileSnapshotForWrite();
      expect(prepared.snapshot.valid).toBe(true);
      expect(prepared.snapshot.sourceConfig.logging?.level).toBe("warn");
      const activeSource: OpenClawConfig = {
        ...prepared.snapshot.sourceConfig,
        logging: { ...prepared.snapshot.sourceConfig.logging, level: "debug" },
      };
      const activeRuntime: OpenClawConfig = {
        ...prepared.snapshot.config,
        logging: { ...prepared.snapshot.config.logging, level: "debug" },
      };
      setSnapshot(activeRuntime, activeSource);
      const base = prepared.snapshot.config;
      const nextConfig: OpenClawConfig = {
        ...base,
        logging: { ...base.logging, level: "debug" },
      };
      await replaceConfigFile({
        nextConfig,
        snapshot: prepared.snapshot,
        baseHash: prepared.snapshot.hash,
        writeOptions: prepared.writeOptions,
        afterWrite: { mode: "auto" },
      });
      const persisted = await readConfig(configPath);
      expect(persisted.logging).toStrictEqual({ level: "debug" });
      expect(sourceSnapshot()?.logging).toStrictEqual(persisted.logging);
    });
  }),
);

for (const failure of ["warnings", "missing-raw", "concurrent", "env"] as const) {
  itWithHome(`preserves rollback state after refresh failure: ${failure}`, async (home) => {
    const envKey = "OPENCLAW_TEST_RUNTIME_ROLLBACK_ENV";
    const initial: OpenClawConfig = {
      ...gatewayAt(18789),
      ...(failure === "warnings"
        ? pluginEntries({ "google-antigravity-auth": { enabled: false } })
        : {}),
    };
    const initialRaw =
      failure === "env"
        ? formatConfig(initial).replace("{", "{ // retained rollback comment")
        : formatConfig(initial);
    const { configPath } = await seedRaw(home, initialRaw);
    const concurrentRaw = formatConfig(gatewayAt(19191));
    const warn = vi.fn();
    const io =
      failure === "warnings"
        ? homeIO(home, {
            configPath,
            env: { HOME: home },
            logger: { warn, error: vi.fn() },
          })
        : undefined;
    if (io) {
      io.loadConfig();
      expect(warn).toHaveBeenCalledTimes(1);
    }
    await withActiveConfig(
      configPath,
      async () => {
        const fail = () => {
          if (failure === "env") {
            expect(process.env[envKey]).toBe("written-env-value");
          }
          throw new Error("synthetic refresh failure");
        };
        setRefreshHandler({
          refresh:
            failure === "concurrent"
              ? async () => {
                  await fs.writeFile(configPath, concurrentRaw, "utf8");
                  return fail();
                }
              : fail,
        });
        const next: OpenClawConfig = {
          ...gatewayAt(19001),
          ...(failure === "warnings"
            ? pluginEntries({ "google-gemini-cli-auth": { enabled: false } })
            : {}),
          ...(failure === "env" ? { env: { vars: { [envKey]: "written-env-value" } } } : {}),
        };
        const rejectWrite = async () => {
          await expect(
            writeConfigFile(
              next,
              failure === "missing-raw"
                ? { baseSnapshot: existingSnapshot(configPath, initial, null) }
                : undefined,
            ),
          ).rejects.toThrow(
            failure === "concurrent"
              ? /config changed since last load/
              : /runtime snapshot refresh failed: synthetic refresh failure/,
          );
        };
        if (failure === "env") {
          await captureUpdateDoctorConfigWrites(configPath, rejectWrite);
        } else {
          await rejectWrite();
        }
        if (failure === "missing-raw") {
          expect((await readConfig(configPath)).gateway).toEqual({ mode: "local", port: 19001 });
        } else {
          await expectRaw(configPath, failure === "concurrent" ? concurrentRaw : initialRaw);
        }
        if (failure === "env") {
          expect(process.env[envKey]).toBeUndefined();
        }
        if (io) {
          io.loadConfig();
          expect(warn).toHaveBeenCalledTimes(1);
        }
      },
      failure === "env" ? { [envKey]: undefined } : {},
    );
  });
}

registerConfigWritePreflightTests({
  itWithHome,
  configPathForHome: homePath,
  formatConfig,
  createConfigIO,
  silentLogger,
});

for (const writer of ["direct", "runtime"] as const) {
  itWithHome(`rechecks ${writer} publication authority after backup work`, async (home) => {
    const { configPath, raw } = await seed(home, gatewayAt(18789));
    const events: string[] = [];
    let active = true;
    setRefreshHandler({
      preflight: () => {
        events.push("preflight");
      },
      refresh: () => true,
    });
    prepareWrite.mockImplementationOnce(async (params) => {
      const actual =
        await vi.importActual<typeof import("./backup-rotation.js")>("./backup-rotation.js");
      const prepared = await actual.prepareConfigFileWrite(params);
      events.push("backup");
      active = false;
      return prepared;
    });
    await withActiveConfig(
      configPath,
      async () => {
        const write =
          writer === "runtime" ? writeConfigFile : fastIO(home, { configPath }).writeConfigFile;
        await expect(
          write(gatewayAt(19001), {
            beforeCommit: async () => {
              events.push("commit");
            },
            assertCurrent: () => {
              if (!active) {
                throw new Error("approval expired");
              }
            },
          }),
        ).rejects.toThrow("approval expired");
      },
      { OPENCLAW_TEST_FAST: "1" },
    );
    expect(events).toEqual(["preflight", "backup", "commit"]);
    expect(await readRaw(configPath)).toBe(raw);
  });
}

itWithHome("rechecks includes before copy fallback creation", async (home) => {
  const configPath = homePath(home);
  const includePath = path.join(path.dirname(configPath), "included.json");
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await writeConfigJson(includePath, { logging: { level: "info" } });
  let renameDenied = false;
  let includeChanged = false;
  const io = fastIO(home, {
    configPath,
    fs: {
      ...fsNode,
      renameSync: (source, destination) => {
        if (destination !== configPath) {
          return fsNode.renameSync(source, destination);
        }
        renameDenied = true;
        throw Object.assign(new Error("rename denied"), { code: "EPERM" });
      },
      readSync: new Proxy(fsNode.readSync, {
        apply(target, thisArg, args) {
          if (renameDenied && !includeChanged) {
            fsNode.writeFileSync(includePath, JSON.stringify({ logging: { level: "debug" } }));
            includeChanged = true;
          }
          return Reflect.apply(target, thisArg, args);
        },
      }),
    },
  });
  const nextConfig = {
    $include: "included.json",
    gateway: { mode: "local" as const },
  };
  await expectWriteError(io, nextConfig, "included config");
  expect(renameDenied).toBe(true);
  expect(includeChanged).toBe(true);
  await expect(fs.stat(configPath)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readConfig(includePath)).toEqual({ logging: { level: "debug" } });
});

for (const { publication, layout } of [
  { publication: "ordinary", layout: "plain" },
  { publication: "prepared-runtime", layout: "include" },
  { publication: "executor-ambient", layout: "plain" },
] as const) {
  itWithHome(
    `preserves copy fallback for ${publication} publication with ${layout} config`,
    async (home) => {
      const { configPath } = await seed(home, {
        gateway: { mode: "local", port: 18789 },
        ...(layout === "include" ? { logging: { $include: "logging.json" } } : {}),
      });
      const includePath = path.join(path.dirname(configPath), "logging.json");
      if (layout === "include") {
        await writeConfigJson(includePath, { level: "info" });
      }
      const denied = Object.assign(new Error("rename denied"), { code: "EPERM" });
      const io = fastIO(home, {
        configPath,
        fs: {
          ...fsNode,
          renameSync: () => {
            throw denied;
          },
        },
      });
      const prepared =
        publication !== "ordinary" ? await io.readConfigFileSnapshotForWrite() : undefined;
      const assertWriteOutcome = async (assertCurrent?: () => void) => {
        const options: ConfigWriteOptions = {
          ...(prepared ? { ...prepared.writeOptions, baseSnapshot: prepared.snapshot } : {}),
          ...(assertCurrent ? { assertCurrent } : {}),
          observe: false,
          skipPluginValidation: true,
          skipRuntimeSnapshotRefresh: true,
        };
        const nextConfig = {
          gateway: { mode: "local" as const, port: 19001 },
          ...(layout === "include" ? { logging: { level: "info" as const } } : {}),
        };
        const write =
          publication === "prepared-runtime"
            ? writeConfigFile(nextConfig, options)
            : io.writeConfigFile(nextConfig, options);
        await write;
        expect(await readConfig(configPath)).toMatchObject({
          gateway: { port: 19001 },
          ...(layout === "include" ? { logging: { $include: "logging.json" } } : {}),
        });
        expect(auditRecords(home, io.env)).toContainEqual(
          expect.objectContaining({
            event: "config.write",
            configPath,
            result: "copy-fallback",
          }),
        );
      };
      const rename =
        publication === "prepared-runtime"
          ? vi.spyOn(fsNode, "renameSync").mockImplementation(() => {
              throw denied;
            })
          : undefined;
      try {
        await withActiveConfig(
          configPath,
          async () => {
            if (publication.startsWith("executor-")) {
              const root = path.join(await fs.realpath(home), "package");
              await fs.mkdir(root);
              const databasePath = path.join(home, "control", "managed-update-handoffs.sqlite");
              createManagedHandoffLeaseDatabase(databasePath)(true, () => undefined);
              const existingAuthority = {
                ...captureManagedUpdateLeaseDatabaseIdentity(databasePath),
                installKey: root,
              };
              await withUpdateCommandExecutor(
                "config-write-fallback",
                async (executor) => {
                  const fence = await executor.enter(root);
                  await withConfigWriteLock(
                    configPath,
                    () => assertWriteOutcome(),
                    io.env,
                    fence.assertCurrent,
                  );
                },
                { existingAuthority },
              );
            } else {
              await assertWriteOutcome();
            }
          },
          { OPENCLAW_STATE_DIR: path.dirname(configPath), OPENCLAW_TEST_FAST: "1" },
        );
      } finally {
        rename?.mockRestore();
      }
      if (layout === "include") {
        expect(await readConfig(includePath)).toEqual({ level: "info" });
      }
    },
  );
}

itWithHome("retains write failure after authority revocation", async (home) => {
  const { configPath, raw } = await seed(home, gatewayAt(18789));
  const primaryError = new Error("rename failed before publication");
  const provenanceAfterRevocation = vi.fn(() => {
    throw new ConfigMutationConflictError("config path changed since last load", {
      retryable: false,
    });
  });
  await withExecutor(home, "config-write-failure-fence", async (assertCurrent, revoke) => {
    let revoked = false;
    const io = fastIO(home, {
      configPath,
      fs: {
        ...fsNode,
        renameSync: (source, destination) => {
          if (destination !== configPath) {
            return fsNode.renameSync(source, destination);
          }
          revoke();
          revoked = true;
          throw primaryError;
        },
      },
    });
    const priorAudit = auditRecords(home, io.env);
    const failure = await io
      .writeConfigFile(gatewayAt(19001), {
        assertCurrent,
        assertConfigPathForWrite: () => {
          if (revoked) {
            provenanceAfterRevocation();
          }
        },
      })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    if (!(failure instanceof AggregateError)) {
      throw new Error("expected the write and authority failures");
    }
    expect(failure.message).toBe(
      "Config write failed after source ownership changed: rename failed before publication",
    );
    expect(failure.errors).toHaveLength(2);
    expect(failure.errors[0]).toBe(primaryError);
    expect(failure.errors[1]).toHaveProperty(
      "message",
      expect.stringContaining("executor ownership is no longer current"),
    );
    expect(failure.cause).toBe(failure.errors[1]);
    expect(provenanceAfterRevocation).not.toHaveBeenCalled();
    expect(await readRaw(configPath)).toBe(raw);
    expect(auditRecords(home, io.env)).toEqual(priorAudit);
  });
});

itWithHome("rolls back exhausted canonical env rereads", async (home) => {
  const initialConfig = gatewayAt(18789);
  const { configPath, raw: initialRaw } = await seed(home, initialConfig);
  const readFileSync = fsNode.readFileSync.bind(fsNode);
  let generationChanges = 0;
  const readSpy = vi.spyOn(fsNode, "readFileSync").mockImplementation((target, options) => {
    const result = readFileSync(target, options);
    if (String(target) === configPath && String(result).includes("19001")) {
      generationChanges += 1;
      initializePublishedConfigRuntimeEnv(initialConfig);
    }
    return result;
  });
  listen(() => {}, {
    ownsRuntimeActivationFor: configPath,
    preCommitRuntimePreflight: async (sourceConfig) => ({
      runtimeConfig: sourceConfig,
      compareConfig: sourceConfig,
    }),
  });
  cleanups.push(() => readSpy.mockRestore());
  await withActiveConfig(configPath, async () => {
    setSnapshot(initialConfig, initialConfig);
    initializePublishedConfigRuntimeEnv(initialConfig);
    await expect(writeConfigFile(gatewayAt(19001))).rejects.toThrow(
      "active config environment changed during every canonical reread",
    );
  });
  expect(generationChanges).toBeGreaterThanOrEqual(3);
  await expectRaw(configPath, initialRaw);
});

itWithHome("uses injected fs to roll back ownership loss", async (home) => {
  const otherConfigPath = homePath(home, "other.json");
  const initialConfig = gatewayAt(18789);
  const { configPath, raw: initialRaw } = await seed(home, initialConfig);
  const env = {
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_TEST_FAST: "1",
  };
  const readFile = fsNode.promises.readFile.bind(fsNode.promises);
  const rename = fsNode.renameSync;
  let committed = false;
  let rollbackReadUsedInjectedFs = false;
  const injectedFs = configFs(
    {
      renameSync: (from, to) => {
        rename(from, to);
        if (!committed && to === configPath) {
          committed = true;
          env.OPENCLAW_CONFIG_PATH = otherConfigPath;
        }
      },
    },
    {},
  ) satisfies typeof fsNode;
  vi.spyOn(injectedFs.promises, "readFile").mockImplementation(async (target, options) => {
    if (committed && target === configPath) {
      rollbackReadUsedInjectedFs = true;
    }
    return await readFile(target, options);
  });
  const io = createConfigIO({ env, fs: injectedFs, homedir: () => home, logger: silentLogger });
  const prepared = await io.readConfigFileSnapshotForWrite();
  const priorAudit = auditRecords(home, io.env);
  const pending = io.writeConfigFile(gatewayAt(19001), {
    baseSnapshot: prepared.snapshot,
    ...prepared.writeOptions,
  });
  await expect(pending).rejects.toThrow("config path changed since last load");
  const failure = await pending.catch((error: unknown) => error);
  expect(failure).toMatchObject({
    name: "ConfigWritePostCommitError",
    configPath,
    rollbackStatus: "restored",
    cause: expect.any(ConfigMutationConflictError),
  });
  expect(failure).toHaveProperty("cause.retryable", false);
  expect(rollbackReadUsedInjectedFs).toBe(true);
  await expectRaw(configPath, initialRaw);
  expect(auditRecords(home, io.env)).toEqual(priorAudit);
});

itWithHome("persists explicit defaults through public writes", async (home) => {
  loadRegistry.mockReturnValue(
    pluginRegistry("demo", {
      type: "object",
      properties: { mode: { type: "string", default: "auto" } },
      additionalProperties: true,
    }),
  );
  const sourceConfig = {
    gateway: { mode: "local" },
    plugins: { entries: { demo: { enabled: true, config: {} } } },
  } satisfies ConfigFileSnapshot["sourceConfig"];
  const { configPath } = await seed(home, sourceConfig);
  const runtimeConfig = {
    ...structuredClone(sourceConfig),
    ...pluginEntries({ demo: { enabled: true, config: { mode: "auto" } } }),
  } satisfies ConfigFileSnapshot["config"];
  await withActiveConfig(configPath, async () => {
    setSnapshot(runtimeConfig, sourceConfig);
    await writeConfigFile(runtimeConfig, {
      explicitSetPaths: [["plugins", "entries", "demo", "config"]],
    });
    const persisted = await readConfig(configPath);
    expect(persisted.plugins?.entries?.demo?.config).toStrictEqual({ mode: "auto" });
    const auditRecord = auditRecords(home, process.env)
      .filter((record) => record.event === "config.write")
      .findLast((record) => record.configPath === configPath);
    expect(auditRecord).toMatchObject({ changedPathCount: expect.any(Number) });
    if (!auditRecord || auditRecord.event !== "config.write") {
      throw new Error("expected config write audit record");
    }
    expect(auditRecord.changedPathCount).toBeGreaterThanOrEqual(1);
    expect(auditRecord.changedPaths).toContain("plugins.entries.demo.config");
  });
});

itWithHome("skips only plugin validation (#76800)", async (home) => {
  const { configPath } = await seedRaw(home, "{}\n");
  loadRegistry.mockReturnValue(
    pluginRegistry("strict-plugin", {
      type: "object",
      properties: { token: { type: "string" } },
      required: ["token"],
      additionalProperties: false,
    }),
  );
  // Plugin is enabled but missing required "token" — validation fails without skip.
  const cfg: OpenClawConfig = {
    agents: { entries: { main: {} } },
    plugins: { entries: { "strict-plugin": { enabled: true } } },
  };
  await withActiveConfig(configPath, async () => {
    await writeConfigFile(cfg, { skipPluginValidation: true });
    await expect(readRaw(configPath)).resolves.toContain('"strict-plugin"');
    await expect(writeConfigFile(cfg, { skipPluginValidation: false })).rejects.toThrow(
      /Config validation failed/,
    );
    await expect(
      writeConfigFile(agentEntries("not-array") as unknown as OpenClawConfig, {
        skipPluginValidation: true,
      }),
    ).rejects.toThrow(/Config validation failed/);
  });
});

itWithHome("preserves tilde paths from runtime-shaped writes", async (home) => {
  const { configPath } = await seed(home, {
    $schema: "https://openclaw.ai/config.json",
    logging: { file: "~/openclaw-upgrade-survivor/gateway.jsonl" },
  });
  const io = fastIO(home);
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
  const persisted = await readConfig(configPath);
  expect(persisted).toMatchObject({
    $schema: "https://openclaw.ai/config.json",
    logging: { file: "~/openclaw-upgrade-survivor/gateway.jsonl", level: "debug" },
  });
});

itWithHome("warns just before stripping JSON5 comments", async (home) => {
  const raw = `{
// Keep this operator note.
gateway: { mode: "local", port: 18789 }
}
`;
  const { configPath } = await seedRaw(home, raw);
  const commentWarnings: string[] = [];
  const warn = vi.fn((message: string) => {
    if (!message.startsWith("Config write will strip JSON5 comments")) {
      return;
    }
    expect(fsNode.readFileSync(configPath, "utf-8")).toBe(raw);
    commentWarnings.push(message);
  });
  const io = fastIO(home, {
    logger: { warn, error: vi.fn() },
  });
  const nextConfig = gatewayAt(18790);
  await expectWriteError(io, nextConfig, "blocked before commit", {
    preCommitRuntimePreflight: async () => {
      throw new Error("blocked before commit");
    },
  });
  expect(commentWarnings).toEqual([]);
  await io.writeConfigFile(nextConfig);
  expect(commentWarnings).toEqual([`Config write will strip JSON5 comments from ${configPath}.`]);
  await expect(readRaw(configPath)).resolves.not.toContain("operator note");
});

itWithHome("audits Doctor paths and snapshot fingerprints", async (home) => {
  const originalVars = Object.fromEntries(
    Array.from({ length: 70 }, (_, index) => [
      `SETTING_${index.toString().padStart(2, "0")}`,
      "before",
    ]),
  );
  const nextVars = Object.fromEntries(Object.keys(originalVars).map((key) => [key, "after"]));
  const { configPath } = await seed(home, {
    env: { vars: originalVars },
    gateway: { port: 18789 },
  });
  const io = fastIO(home);
  const snapshot = await io.readConfigFileSnapshot();
  const nextConfig = structuredClone(snapshot.config);
  nextConfig.env = { ...nextConfig.env, vars: nextVars };
  const result = await withActiveConfig(
    configPath,
    () =>
      writeConfigFile(nextConfig, {
        baseSnapshot: snapshot,
        expectedConfigPath: configPath,
        auditOrigin: "doctor",
        afterWrite: { mode: "none", reason: "automatic migration" },
        skipOutputLogs: true,
        skipRuntimeSnapshotRefresh: true,
      }),
    { OPENCLAW_STATE_DIR: path.join(home, ".openclaw"), OPENCLAW_TEST_FAST: "1" },
  );
  const record = auditRecords(home, io.env)
    .filter((candidate) => candidate.event === "config.write")
    .findLast((candidate) => candidate.configPath === configPath);
  expect(record).toMatchObject({
    event: "config.write",
    configPath,
    result: "rename",
    previousHash: snapshot.hash,
    nextHash: result.persistedHash,
    // The runtime writer also records its managed plugins.installs removal.
    changedPathCount: 71,
  });
  if (!record || record.event !== "config.write") {
    throw new Error("expected config write audit record");
  }
  expect(record.origin).toBe("doctor");
  expect((await io.readConfigFileSnapshot()).hash).toBe(result.persistedHash);
  expect(record.changedPaths).toHaveLength(64);
  expect(record.changedPaths?.at(-1)).toBe("…+8 more");
  expect(record.changedPaths?.slice(0, 2)).toEqual(["env.vars.SETTING_00", "env.vars.SETTING_01"]);
  const slot = await readLatestConfigSnapshotAuditRecordAsync({
    env: { OPENCLAW_TEST_FAST: "1" },
    homedir: () => home,
  });
  expect(slot).toMatchObject({ configPath, rawHash: result.persistedHash });
  if (!slot) {
    throw new Error("expected snapshot slot");
  }
  // The slot is diff-only, so every leaf is fingerprinted.
  const slotVars =
    (slot.fingerprintedAuthoredConfig as { env?: { vars?: Record<string, string> } }).env?.vars ??
    {};
  expect(Object.keys(slotVars)).toHaveLength(70);
  for (const [name, value] of Object.entries(slotVars)) {
    expect(value, name).toMatch(/^fp:[0-9a-f]{12}$/);
  }
  expect(
    (slot.fingerprintedAuthoredConfig as { gateway?: { port?: string } }).gateway?.port,
  ).toMatch(/^fp:[0-9a-f]{12}$/);
});

itWithHome("journals offline edits before replacing the slot", async (home) => {
  const configPath = homePath(home);
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await withActiveConfig(
    configPath,
    async () => {
      const io = homeIO(home, {
        configPath,
        env: process.env,
      });
      const firstWrite = await io.writeConfigFile({ gateway: { port: 18789 } });
      await writeConfigJson(configPath, { gateway: { port: 18790 } });
      const offlineSnapshot = await io.readConfigFileSnapshot();
      const secondWrite = await io.writeConfigFile({ gateway: { port: 18791 } });
      const records = auditRecords(home, process.env);
      expect(records).toContainEqual(
        expect.objectContaining({
          event: "config.external",
          detectedBy: "write",
          previousHash: firstWrite.persistedHash,
          nextHash: offlineSnapshot.hash,
          changedPaths: expect.arrayContaining(["gateway.port"]),
        }),
      );
      expect(records).toContainEqual(
        expect.objectContaining({
          event: "config.write",
          nextHash: secondWrite.persistedHash,
        }),
      );
    },
    { OPENCLAW_STATE_DIR: path.join(home, ".openclaw"), OPENCLAW_TEST_FAST: "1" },
  );
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */

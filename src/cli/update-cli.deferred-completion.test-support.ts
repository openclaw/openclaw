import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "../config/types.openclaw.js";
import { withEnvAsync } from "../test-utils/env.js";
import type { TempHomeEnv } from "../test-utils/temp-home.js";
import { createCliRuntimeCapture, getMockCallOutput } from "./test-runtime-capture.js";

export const readPackageVersion = vi.fn();
export const syncPluginsForUpdateChannel = vi.fn();
export const updateNpmInstalledPlugins = vi.fn();
export const loadInstalledPluginIndexInstallRecords = vi.fn();
export const pathExists = vi.fn();
export const spawn = vi.fn();
export const observeUpdateGatewayReadiness =
  vi.fn<typeof import("./update-cli/update-command-readiness.js").observeUpdateGatewayReadiness>();
const { defaultRuntime: runtimeCapture, resetRuntimeCapture } = createCliRuntimeCapture();
const sqliteHostPlatform = process.platform;

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn,
}));
vi.mock("../process/exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../process/exec.js")>()),
  runCommandWithTimeout: vi.fn(),
  runExec: vi.fn(),
}));
vi.mock("../runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../runtime.js")>()),
  defaultRuntime: runtimeCapture,
}));
vi.mock("../infra/update-runner.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/update-runner.js")>()),
  runGatewayUpdate: vi.fn(),
}));
vi.mock("../infra/update-check.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/update-check.js")>()),
  resolveUpdateInstallKind: vi.fn(async () => "git"),
}));
vi.mock("../plugins/installed-plugin-index-records.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/installed-plugin-index-records.js")>()),
  loadInstalledPluginIndexInstallRecords,
  writePersistedInstalledPluginIndexInstallRecordsWithLease: vi.fn(async () => ({
    previous: null,
    revision: 1,
  })),
}));
vi.mock("../plugins/installed-plugin-index-store.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/installed-plugin-index-store.js")>()),
  readPersistedInstalledPluginIndex: vi.fn(async () => null),
}));
vi.mock("../plugins/installed-plugin-index-store-write.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/installed-plugin-index-store-write.js")>()),
  restorePersistedInstalledPluginIndexIfCurrent: vi.fn(async () => true),
}));
vi.mock("../config/config.js", () => {
  const readConfigFileSnapshot = vi.fn();
  return {
    createConfigIO: (
      options: {
        pluginValidation?: string;
        observe?: boolean;
        suppressFutureVersionWarning?: boolean;
      } = {},
    ) => ({
      readConfigFileSnapshotForWrite: async () => ({
        snapshot: await readConfigFileSnapshot({
          ...(options.pluginValidation === "skip" ? { skipPluginValidation: true } : {}),
          ...(options.observe !== undefined ? { observe: options.observe } : {}),
          ...(options.suppressFutureVersionWarning !== undefined
            ? { suppressFutureVersionWarning: options.suppressFutureVersionWarning }
            : {}),
        }),
        writeOptions: {},
      }),
    }),
    assertConfigWriteAllowedInCurrentMode: () => {
      if (process.env.OPENCLAW_NIX_MODE === "1") {
        throw new Error(
          [
            "Config is managed by Nix (`OPENCLAW_NIX_MODE=1`), so OpenClaw treats openclaw.json as immutable.",
            "Do not run setup, onboarding, openclaw update, plugin install/update/uninstall/enable, doctor repair/token-generation, or config set against this file.",
            "Agent-first Nix setup: https://github.com/openclaw/nix-openclaw#quick-start",
            "OpenClaw Nix overview: https://docs.openclaw.ai/install/nix",
          ].join("\n"),
        );
      }
    },
    ConfigMutationConflictError: class ConfigMutationConflictError extends Error {
      constructor(message: string) {
        super(message);
        this.name = "ConfigMutationConflictError";
      }
    },
    parseConfigJson5: (raw: string) => {
      try {
        return { ok: true, parsed: JSON.parse(raw) };
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    },
    readConfigFileSnapshot,
    readSourceConfigBestEffort: vi.fn(),
    mutateConfigFileWithRetry: vi.fn(),
    replaceConfigFile: vi.fn(),
    resolveGatewayPort: vi.fn(() => 18789),
  };
});

vi.mock("../daemon/gateway-entrypoint.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../daemon/gateway-entrypoint.js")>();
  return {
    ...actual,
    resolveGatewayInstallEntrypoint: vi.fn(actual.resolveGatewayInstallEntrypoint),
  };
});

vi.mock("./update-cli/update-command-readiness.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-cli/update-command-readiness.js")>()),
  observeUpdateGatewayReadiness: (...args: Parameters<typeof observeUpdateGatewayReadiness>) =>
    observeUpdateGatewayReadiness(...args),
}));

vi.mock("./update-cli/update-command-post-plugin-readiness.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./update-cli/update-command-post-plugin-readiness.js")>();
  return {
    ...actual,
    applyPostPluginUpdateReadiness: vi.fn(
      async (params: Parameters<typeof actual.applyPostPluginUpdateReadiness>[0]) =>
        params.pluginUpdate,
    ),
  };
});

vi.mock("../utils.js", async (importOriginal) => {
  const [actual, { isRecord: isRecordGuard }] = await Promise.all([
    importOriginal<typeof import("../utils.js")>(),
    import("@openclaw/normalization-core/record-coerce"),
  ]);
  return {
    ...actual,
    displayString: (input: string) => input,
    isRecord: isRecordGuard,
    pathExists: (...args: unknown[]) => pathExists(...args),
    resolveConfigDir: () => "/tmp/openclaw-config",
    sleep: vi.fn(async () => undefined),
  };
});

vi.mock("../plugins/official-external-install-records.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/official-external-install-records.js")>()),
  resolveTrustedSourceLinkedOfficialClawHubSpec: vi.fn(() => undefined),
  resolveTrustedSourceLinkedOfficialNpmSpec: vi.fn(() => undefined),
}));

vi.mock("../plugins/update.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugins/update.js")>();
  return {
    ...actual,
    syncPluginsForUpdateChannel: (...args: unknown[]) => syncPluginsForUpdateChannel(...args),
    updateNpmInstalledPlugins: (...args: unknown[]) => updateNpmInstalledPlugins(...args),
  };
});

vi.mock("../commands/doctor/shared/post-core-plugin-convergence.js", () => ({
  runPostCorePluginConvergence: vi.fn(async (params: { baselineInstallRecords?: unknown }) => ({
    changes: [],
    warnings: [],
    errored: false,
    smokeFailures: [],
    installRecords: params.baselineInstallRecords ?? {},
  })),
}));

const nodeSqlite = await import("../infra/node-sqlite.js");
const windowsPrivateDirectory = await import("../infra/windows-private-directory.js");
const { createTempHomeEnv } = await import("../test-utils/temp-home.js");
const existingHostUri = nodeSqlite.resolveExistingSqliteFileUri;
const immutableHostUri = nodeSqlite.resolveImmutableSqliteFileUri;
export const { runGatewayUpdate } = await import("../infra/update-runner.js");
export const { runExec, runCommandWithTimeout } = await import("../process/exec.js");
export const { defaultRuntime, ExitError } = await import("../runtime.js");
export const { readConfigFileSnapshot, replaceConfigFile, mutateConfigFileWithRetry } =
  await import("../config/config.js");
export const { resolveGatewayInstallEntrypoint } = await import("../daemon/gateway-entrypoint.js");
export const { updateFinalizeCommand } = await import("./update-cli/update-command-finalize.js");
const { updateCommand } = await import("./update-cli/update-command.js");
const { closeOpenClawStateDatabaseForTest } = await import("../state/openclaw-state-db.js");
const shared = await import("./update-cli/shared.js");
const postCorePluginConvergence =
  await import("../commands/doctor/shared/post-core-plugin-convergence.js");
export const runPostCorePluginConvergenceSpy = vi.spyOn(
  postCorePluginConvergence,
  "runPostCorePluginConvergence",
);

export function installDeferredCompletionFixture() {
  const dirs = useAutoCleanupTempDirTracker(afterEach);
  let tempHome: TempHomeEnv | undefined;
  let fixtureRoot = "";
  let fixtureCount = 0;
  const createCaseDir = (prefix: string) => path.join(fixtureRoot, `${prefix}-${fixtureCount++}`);
  const FRESH_POST_UPDATE_ENTRYPOINT = "/tmp/openclaw-updated-entry.mjs";
  const baseConfig = {} as OpenClawConfig;
  const baseSnapshot: ConfigFileSnapshot = {
    path: "/tmp/openclaw-config.json",
    exists: true,
    raw: "{}",
    parsed: {},
    resolved: baseConfig,
    sourceConfig: baseConfig,
    valid: true,
    config: baseConfig,
    runtimeConfig: baseConfig,
    issues: [],
    warnings: [],
    legacyIssues: [],
  };

  const syncPluginCall = (index = 0) => {
    const calls = syncPluginsForUpdateChannel.mock.calls as unknown as Array<
      [Record<string, unknown> & { channel?: string; config?: OpenClawConfig }]
    >;
    return calls[index]?.[0];
  };

  const npmPluginUpdateCall = (index = 0) => {
    const calls = updateNpmInstalledPlugins.mock.calls as unknown as Array<
      [Record<string, unknown> & { config?: OpenClawConfig; timeoutMs?: number }]
    >;
    return calls[index]?.[0];
  };
  const lastNpmPluginUpdateCall = () =>
    npmPluginUpdateCall(updateNpmInstalledPlugins.mock.calls.length - 1);

  const replaceConfigCall = (index = 0) => vi.mocked(replaceConfigFile).mock.calls[index]?.[0];
  const lastReplaceConfigCall = () =>
    replaceConfigCall(vi.mocked(replaceConfigFile).mock.calls.length - 1);
  const setupConfigMutationWithRetryMock = (
    onCommitted?: (snapshot: ConfigFileSnapshot, nextConfig: OpenClawConfig) => void,
  ) => {
    vi.mocked(mutateConfigFileWithRetry).mockImplementation(async (params) => {
      const snapshot = await readConfigFileSnapshot();
      const nextConfig = structuredClone(snapshot.sourceConfig) as OpenClawConfig;
      await params.mutate(nextConfig, {
        snapshot,
        previousHash: snapshot.hash ?? null,
        attempt: 0,
      });
      await replaceConfigFile({
        nextConfig,
        ...(snapshot.hash !== undefined ? { baseHash: snapshot.hash } : {}),
      });
      onCommitted?.(snapshot, nextConfig);
      return {
        path: snapshot.path,
        previousHash: snapshot.hash ?? null,
        snapshot,
        nextConfig,
        persistedHash: snapshot.hash ?? null,
        result: undefined,
        attempts: 1,
        afterWrite: { mode: "none", reason: "test" },
        followUp: { mode: "none", reason: "test", requiresRestart: false },
      };
    });
  };

  const writeJsonCall = (index = 0) => vi.mocked(defaultRuntime.writeJson).mock.calls[index]?.[0];
  const lastWriteJsonCall = () =>
    writeJsonCall(vi.mocked(defaultRuntime.writeJson).mock.calls.length - 1);
  const getLogOutput = () => getMockCallOutput(vi.mocked(defaultRuntime.log));
  const getErrorOutput = () => getMockCallOutput(vi.mocked(defaultRuntime.error));
  const mockFileBackedPathExists = () => {
    pathExists.mockImplementation(async (candidate: string) => {
      try {
        await fs.access(candidate);
        return true;
      } catch {
        return false;
      }
    });
  };

  const pluginSyncResult = (
    config: OpenClawConfig,
    changed = false,
    overrides: {
      warnings?: string[];
      errors?: Array<{ pluginId: string; message: string; code?: string }>;
    } = {},
  ) => ({
    changed,
    config,
    summary: {
      switchedToBundled: [],
      switchedToClawHub: [],
      switchedToNpm: [],
      warnings: [],
      errors: [],
      ...overrides,
    },
  });

  const npmPluginUpdateResult = (config: OpenClawConfig) => ({
    changed: false,
    config,
    outcomes: [],
  });

  const mockNpmPluginOutcomes = (
    outcomes: unknown[],
    changed = false,
    config: OpenClawConfig = baseConfig,
  ) => {
    updateNpmInstalledPlugins.mockResolvedValueOnce({ changed, config, outcomes });
  };

  const postCoreConvergenceResult = (
    overrides: Partial<{
      changes: string[];
      warnings: Array<{ pluginId?: string; reason: string; message: string; guidance: string[] }>;
      errored: boolean;
    }> = {},
  ) => ({
    changes: [],
    warnings: [],
    errored: false,
    smokeFailures: [],
    installRecords: {},
    ...overrides,
  });

  const mockNoopPostUpdatePluginConvergence = () => {
    syncPluginsForUpdateChannel.mockImplementation(async ({ config }) => pluginSyncResult(config));
    updateNpmInstalledPlugins.mockImplementation(async ({ config }) =>
      npmPluginUpdateResult(config),
    );
  };

  const mockPostDoctorSnapshot = (
    configPath: string,
    config: OpenClawConfig,
    options: { preserveParsed?: boolean } = {},
  ) => {
    vi.mocked(readConfigFileSnapshot).mockResolvedValue({
      ...baseSnapshot,
      path: configPath,
      ...(options.preserveParsed ? {} : { parsed: config }),
      sourceConfig: config,
      config,
      runtimeConfig: config,
      hash: "post-doctor-hash",
    });
  };

  const configSnapshot = (
    config: OpenClawConfig,
    overrides: Partial<ConfigFileSnapshot> = {},
  ): ConfigFileSnapshot => ({
    ...baseSnapshot,
    parsed: config,
    resolved: config,
    sourceConfig: config,
    config,
    runtimeConfig: config,
    ...overrides,
  });

  const stableConfig = (overrides: Omit<OpenClawConfig, "update"> = {}): OpenClawConfig => ({
    update: { channel: "stable" },
    ...overrides,
  });

  const stableWhatsAppConfig = (): OpenClawConfig =>
    stableConfig({
      channels: {
        whatsapp: { enabled: true, dmPolicy: "pairing" },
      },
    });

  const runPostCoreUpdate = (env: NodeJS.ProcessEnv = {}) => {
    return withEnvAsync(
      {
        OPENCLAW_UPDATE_POST_CORE: "1",
        OPENCLAW_UPDATE_POST_CORE_CHANNEL: "stable",
        OPENCLAW_COMPATIBILITY_HOST_VERSION: process.env.OPENCLAW_COMPATIBILITY_HOST_VERSION,
        ...env,
      },
      async () => {
        await updateCommand({ yes: true, restart: false });
      },
    );
  };

  const runPostCoreCommand = (
    options: Parameters<typeof updateCommand>[0],
    env: NodeJS.ProcessEnv = {},
  ) => {
    return withEnvAsync(
      {
        OPENCLAW_UPDATE_POST_CORE: "1",
        OPENCLAW_UPDATE_POST_CORE_CHANNEL: "stable",
        OPENCLAW_COMPATIBILITY_HOST_VERSION: process.env.OPENCLAW_COMPATIBILITY_HOST_VERSION,
        ...env,
      },
      async () => {
        await updateCommand(options);
      },
    );
  };

  const writeJsonFixture = (
    filePath: string,
    value: unknown,
    trailingNewline = true,
  ): Promise<void> =>
    fs.writeFile(filePath, `${JSON.stringify(value)}${trailingNewline ? "\n" : ""}`, "utf-8");

  const setupPostCoreConfigFixture = async (params: {
    backupConfig?: OpenClawConfig;
    postDoctorConfig: OpenClawConfig;
    preUpdateConfig?: OpenClawConfig;
    snapshotSuffix?: ".bak" | ".pre-update";
    preserveParsed?: boolean;
  }) => {
    const tempDir = createCaseDir("openclaw-update");
    const configPath = path.join(tempDir, "openclaw.json");
    await fs.mkdir(tempDir, { recursive: true });
    if (params.preUpdateConfig) {
      await writeJsonFixture(
        `${configPath}${params.snapshotSuffix ?? ".pre-update"}`,
        params.preUpdateConfig,
      );
    }
    if (params.backupConfig) {
      await writeJsonFixture(`${configPath}.bak`, params.backupConfig);
    }
    await writeJsonFixture(configPath, params.postDoctorConfig);
    mockPostDoctorSnapshot(configPath, params.postDoctorConfig, {
      preserveParsed: params.preserveParsed,
    });
    mockNoopPostUpdatePluginConvergence();
    return { tempDir, configPath };
  };

  beforeEach(async () => {
    tempHome = await createTempHomeEnv("openclaw-deferred-completion-");
    fixtureRoot = dirs.make("openclaw-deferred-completion-fixtures-");
    vi.resetAllMocks();
    resetRuntimeCapture();
    for (const key of [
      "OPENCLAW_COMPATIBILITY_HOST_VERSION",
      "OPENCLAW_UPDATE_RUN_HANDOFF",
      "OPENCLAW_UPDATE_RUN_ID",
      "OPENCLAW_UPDATE_POST_CORE_RESULT_PATH",
      "OPENCLAW_UPDATE_POST_CORE_STARTED_AT_MS",
    ]) {
      vi.stubEnv(key, undefined);
    }
    vi.spyOn(shared, "readPackageVersion").mockImplementation(readPackageVersion);
    readPackageVersion.mockResolvedValue("1.0.0");
    vi.mocked(defaultRuntime.exit).mockImplementation(() => {});
    vi.mocked(readConfigFileSnapshot).mockResolvedValue(baseSnapshot);
    // Finalization failure observes the fixture's absent Gateway without contacting the host.
    observeUpdateGatewayReadiness.mockImplementation(async ({ gatewayPort, assertCurrent }) => {
      assertCurrent?.();
      return {
        health: {
          healthy: false,
          waitOutcome: "stopped-free",
          runtime: { status: "stopped" },
          portUsage: { port: gatewayPort, status: "free", listeners: [], hints: [] },
          staleGatewayPids: [],
        },
        readyz: false,
        http: undefined,
        launchAgentRecovery: null,
      };
    });
    setupConfigMutationWithRetryMock();
    loadInstalledPluginIndexInstallRecords.mockResolvedValue({});
    syncPluginsForUpdateChannel.mockImplementation(async ({ config }) => pluginSyncResult(config));
    updateNpmInstalledPlugins.mockImplementation(async ({ config }) =>
      npmPluginUpdateResult(config),
    );
    const entrypoint = path.join(process.cwd(), "dist", "index.js");
    pathExists.mockImplementation(async (candidate: string) => candidate === entrypoint);
    // Child completion may invoke only Doctor, config validation, and the parent's start probe.
    vi.mocked(runExec).mockImplementation(async (file, args) => {
      if (file === process.execPath && (args[1] === "doctor" || args[1] === "config")) {
        return { stdout: "", stderr: "" };
      }
      if (file === "ps") {
        return { stdout: new Date(Date.now() - 1000).toString(), stderr: "" };
      }
      throw new Error(`Unexpected completion process: ${file}`);
    });
    vi.mocked(runCommandWithTimeout).mockRejectedValue(
      new Error("Completion must not run a core install"),
    );
    vi.mocked(runGatewayUpdate).mockRejectedValue(new Error("Completion must not run core update"));
    spawn.mockImplementation(() => {
      throw new Error("Completion must not spawn core update");
    });
    vi.spyOn(nodeSqlite, "resolveExistingSqliteFileUri").mockImplementation((file) =>
      existingHostUri(file, sqliteHostPlatform),
    );
    vi.spyOn(nodeSqlite, "resolveImmutableSqliteFileUri").mockImplementation((file) =>
      immutableHostUri(file, sqliteHostPlatform),
    );
    if (sqliteHostPlatform !== "win32") {
      vi.spyOn(windowsPrivateDirectory, "createPrivateWindowsDirectory").mockImplementation(
        (dir) => {
          fsSync.mkdirSync(dir, { mode: 0o700 });
        },
      );
      vi.spyOn(windowsPrivateDirectory, "createPrivateWindowsFile").mockImplementation((file) =>
        fsSync.openSync(
          file,
          fsSync.constants.O_RDWR |
            fsSync.constants.O_CREAT |
            fsSync.constants.O_EXCL |
            fsSync.constants.O_NOFOLLOW,
          0o600,
        ),
      );
    }
  });
  afterEach(async () => {
    closeOpenClawStateDatabaseForTest();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await tempHome?.restore();
  });
  return {
    runPostCoreCommand,
    lastNpmPluginUpdateCall,
    postCoreConvergenceResult,
    syncPluginCall,
    lastWriteJsonCall,
    mockNpmPluginOutcomes,
    getErrorOutput,
    getLogOutput,
    mockNoopPostUpdatePluginConvergence,
    createCaseDir,
    writeJsonFixture,
    FRESH_POST_UPDATE_ENTRYPOINT,
    configSnapshot,
    stableConfig,
    baseConfig,
    mockFileBackedPathExists,
    stableWhatsAppConfig,
    mockPostDoctorSnapshot,
    runPostCoreUpdate,
    lastReplaceConfigCall,
    setupPostCoreConfigFixture,
  };
}

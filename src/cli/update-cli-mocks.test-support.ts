import { isCancel } from "@clack/core";
import { expectDefined } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  GATEWAY_SERVICE_RUNTIME_PID_ENV,
  GATEWAY_SERVICE_SELECTOR_ENV_KEYS,
} from "../daemon/constants.js";
import type { CallGatewayOptions } from "../gateway/call.js";
import * as nodeSqlite from "../infra/node-sqlite.js";
import { SUPERVISOR_HINT_ENV_VARS } from "../infra/supervisor-markers.js";
import type { RetainUpdateRuntime } from "../infra/update-retained-runtime.js";
import { captureEnv } from "../test-utils/env.js";
import { createCliRuntimeCapture } from "./test-runtime-capture.js";

const commandTransport = vi.hoisted(() => ({
  run: vi.fn<typeof import("../process/exec.js").runCommandWithTimeout>(),
  hostEnv: { ...process.env, NODE_OPTIONS: "", NODE_PATH: "" },
  hostCwd: process.cwd(),
  npmPrefix: "",
}));

const sqliteHostPlatform = process.platform;
const existingHostUri = nodeSqlite.resolveExistingSqliteFileUri;
const immutableHostUri = nodeSqlite.resolveImmutableSqliteFileUri;

const confirm = vi.fn();
const select = vi.fn();
const text = vi.fn();
const spinner = vi.fn(() => ({ start: vi.fn(), stop: vi.fn(), clear: vi.fn() }));
const triageCommand = vi.fn<typeof import("../commands/triage.js").triageCommand>();
const triageAfterFailure =
  vi.fn<typeof import("../commands/triage-failure.js").triageAfterFailure>();
const updateFailureActionMocks = vi.hoisted(() => ({
  runInteractiveUpdateFailureAction: vi.fn(),
}));

const readPackageName = vi.fn();
const readPackageVersion = vi.fn();
const resolveGlobalManager = vi.fn();
const serviceLoaded = vi.fn();
const serviceEnabled = vi.fn();
const serviceDefinitionMutationCapability = vi.fn();
const serviceStart = vi.fn();
const serviceStop = vi.fn();
const serviceRestart = vi.fn();
// A fixed Gateway PID can collide with the updater and trigger its self-stop safeguard.
const gatewayFixturePid = process.pid + 1;
const unrelatedGatewayFixturePid = process.pid + 2;

const suspendScheduledTaskAutoStartForUpdate = vi.fn();
const resumeScheduledTaskAutoStartAfterUpdate = vi.fn();
const managedUpdateHandoff = vi.hoisted(() => ({
  start: vi.fn(),
  transfer: vi.fn(),
  cancel: vi.fn(),
}));
const candidateValidation = vi.hoisted(() => vi.fn());
const retainUpdateRuntime = vi.hoisted(() => vi.fn<RetainUpdateRuntime>());
const systemdPolicy = vi.hoisted(() =>
  vi.fn<typeof import("../daemon/systemd-maintenance.js").prepareSystemdGatewayMaintenance>(),
);
const sourceRuntimeCompletion = vi.hoisted(() =>
  vi.fn<typeof import("./update-cli/update-command-runtime.js").completeSourceUpdateRuntime>(),
);
const pluginAvailabilityPreflight = vi.hoisted(() => vi.fn());
vi.mock("./update-cli/update-command-plugin-preflight.js", () => ({
  preflightConfiguredNpmPluginTargets: pluginAvailabilityPreflight,
}));
const inferenceRepair = vi.hoisted(() =>
  vi.fn<typeof import("../infra/update-repair-agent.js").runUpdateRepairLoop>(),
);
const httpReadiness = vi.hoisted(() => vi.fn());
const stateSchemaVersions = vi.hoisted(() => vi.fn());
const mockedRunDaemonInstall = vi.fn();
const serviceReadCommand = vi.fn();
const serviceReadRuntime = vi.fn();
const serviceFixtureState = { absentServicePort: 0 };
const mockGetSelfAndAncestorPidsSync = vi.fn(() => new Set<number>([process.pid]));
const terminateStaleGatewayPids = vi.fn();
const inspectPortUsage = vi.fn();
const probePortUsage = vi.fn();
const classifyPortListener = vi.fn();
const formatPortDiagnostics = vi.fn();
const callGateway = vi.fn<(opts: CallGatewayOptions) => Promise<unknown>>();
const pathExists = vi.fn();
const syncPluginsForUpdateChannel = vi.fn();
const updateNpmInstalledPlugins = vi.fn();
const loadInstalledPluginIndexInstallRecords = vi.fn(
  async (params: { config?: OpenClawConfig; env?: NodeJS.ProcessEnv } = {}) =>
    params.config?.plugins?.installs ?? {},
);
const readPersistedInstalledPluginIndex = vi.fn(async () => null);
const restorePersistedInstalledPluginIndexIfCurrent = vi.fn<
  typeof import("../plugins/installed-plugin-index-store-write.js").restorePersistedInstalledPluginIndexIfCurrent
>(async () => true);
const writePersistedInstalledPluginIndexInstallRecordsWithLease = vi.fn(async () => ({
  previous: null,
  revision: 1,
}));
const checkShellCompletionStatus = vi.fn();
const ensureCompletionCacheExists = vi.fn();
const installCompletion = vi.fn();
const createPreUpdateConfigSnapshotMock = vi.fn();
const legacyConfigRepairMocks = vi.hoisted(() => ({
  repairLegacyConfigForUpdateChannel:
    vi.fn<
      typeof import("../commands/doctor/legacy-config-repair.js").repairLegacyConfigForUpdateChannel
    >(),
}));
const launchdUpdateCleanupMocks = vi.hoisted(() => ({
  disableCurrentOpenClawUpdateLaunchdJob: vi.fn(async () => false),
}));
const windowsOfflineProbe = vi.hoisted(() => vi.fn(async () => null));
const databasePreflightMocks = vi.hoisted(() => ({
  preflightOpenClawDatabaseSchemas: vi.fn(),
}));
const restartHealthTestControl = vi.hoisted(() => ({
  snapshot: undefined as unknown,
}));
const { nodeVersionSatisfiesEngine, resolveNodeRuntimeInfo, execFile, spawn } = await vi.hoisted(
  async () =>
    (await import("./update-cli/update-cli-process-mocks.test-support.js")).updateCliProcessMocks,
);
const { defaultRuntime: runtimeCapture, resetRuntimeCapture } = createCliRuntimeCapture();
const fixtureEnvSnapshot = captureEnv([
  ...SUPERVISOR_HINT_ENV_VARS,
  "OPENCLAW_COMPATIBILITY_HOST_VERSION",
  "OPENCLAW_UPDATE_RUN_HANDOFF",
  "OPENCLAW_SERVICE_MARKER",
  "OPENCLAW_SERVICE_KIND",
  GATEWAY_SERVICE_RUNTIME_PID_ENV,
  ...GATEWAY_SERVICE_SELECTOR_ENV_KEYS,
  "NPM_CONFIG_GLOBALCONFIG",
  "npm_config_globalconfig",
]);

vi.mock("@clack/prompts", () => ({
  confirm,
  select,
  text,
  isCancel,
  spinner,
  note: vi.fn(),
}));

vi.mock("../infra/update-managed-service-handoff.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/update-managed-service-handoff.js")>()),
  startManagedServiceUpdateHandoff: managedUpdateHandoff.start,
  transferManagedServiceUpdateHandoff: managedUpdateHandoff.transfer,
  cancelManagedServiceUpdateHandoff: managedUpdateHandoff.cancel,
  isCurrentManagedServiceUpdateHandoffProcess: async () => false,
}));
vi.mock("../infra/update-repair-agent.js", () => ({
  runUpdateRepairLoop: inferenceRepair,
}));
vi.mock("../infra/update-candidate-canary.js", () => ({
  validateUpdateCandidateCanary: candidateValidation,
}));
// Runtime retention and publication have real owner/process coverage; CLI
// orchestration must not copy or rebuild the checkout behind its simulated updater.
vi.mock("./update-cli/update-command-runtime.js", () => ({
  completeSourceUpdateRuntime: sourceRuntimeCompletion,
}));
vi.mock("../infra/update-retained-runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/update-retained-runtime.js")>();
  const withRetainedUpdateRuntime: typeof actual.withRetainedUpdateRuntime = (
    moduleUrl,
    operation,
  ) => actual.withRetainedUpdateRuntime(moduleUrl, () => operation(retainUpdateRuntime));
  return { withRetainedUpdateRuntime };
});
vi.mock("../infra/update-candidate-state.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/update-candidate-state.js")>()),
  readUpdateStateSchemaVersions: stateSchemaVersions,
}));

// Fresh diagnostic processes have owner coverage; interactive cases retain the
// real prepared handoff so they verify operator environment and cleanup ordering.
vi.mock("../infra/update-triage.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/update-triage.js")>();
  const runUpdateFailureTriage = vi.fn<typeof actual.runUpdateFailureTriage>(async () => ({
    status: "completed",
    hint: "Triage prepared",
  }));
  return {
    ...actual,
    runUpdateFailureTriage,
    prepareUpdateFailureTriage: async (
      params: Parameters<typeof actual.prepareUpdateFailureTriage>[0],
    ) => {
      if (params.mode === "interactive") {
        return actual.prepareUpdateFailureTriage(params);
      }
      const { mode, runtime } = params;
      return (
        invocation: Parameters<Awaited<ReturnType<typeof actual.prepareUpdateFailureTriage>>>[0],
      ) => runUpdateFailureTriage({ ...invocation, mode, runtime });
    },
  };
});

// Keep CLI orchestration on the canonical Git updater boundary.
vi.mock("../infra/update-runner-git.js", () => ({
  updateGitCheckout: vi.fn(),
}));

vi.mock("../state/openclaw-database-preflight.js", () => ({
  OPENCLAW_DATABASE_SCHEMA_DOCS_URL: "https://docs.openclaw.ai/reference/database-schemas",
  preflightOpenClawDatabaseSchemas: databasePreflightMocks.preflightOpenClawDatabaseSchemas,
}));

vi.mock("../state/openclaw-state-ownership.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/openclaw-state-ownership.js")>()),
  assertOpenClawStateWriteAllowedAtPath: vi.fn(async () => undefined),
}));

vi.mock("../infra/openclaw-root.js", () => ({
  resolveOpenClawPackageRoot: vi.fn(),
  resolveOpenClawPackageRootSync: vi.fn(() => process.cwd()),
}));

vi.mock("../daemon/gateway-entrypoint.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../daemon/gateway-entrypoint.js")>();
  return {
    ...actual,
    resolveGatewayInstallEntrypoint: vi.fn(actual.resolveGatewayInstallEntrypoint),
  };
});

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

vi.mock("../infra/update-check.js", async (importOriginal) => ({
  formatGitInstallLabel: (await importOriginal<typeof import("../infra/update-check.js")>())
    .formatGitInstallLabel,
  checkUpdateStatus: vi.fn(),
  resolveUpdateInstallKind: vi.fn(),
  resolveUpdateInstallIdentity: vi.fn(),
  compareSemverStrings: vi.fn((left: string | null, right: string | null) => {
    const parse = (value: string | null) => {
      if (!value) {
        return null;
      }
      const match = value.match(/(\d+)\.(\d+)\.(\d+)/);
      if (!match) {
        return null;
      }
      return [
        Number.parseInt(match[1] ?? "0", 10),
        Number.parseInt(match[2] ?? "0", 10),
        Number.parseInt(match[3] ?? "0", 10),
      ] as const;
    };
    const a = parse(left);
    const b = parse(right);
    if (!a || !b) {
      return null;
    }
    for (let index = 0; index < a.length; index += 1) {
      const diff =
        expectDefined(a[index], "a[index] test invariant") -
        expectDefined(b[index], "b[index] test invariant");
      if (diff !== 0) {
        return diff;
      }
    }
    return 0;
  }),
  fetchNpmTagVersion: vi.fn(),
  resolveExtendedStablePackage: vi.fn(),
  resolveNpmChannelTag: vi.fn(),
}));

vi.mock("../infra/update-check-package-target.js", () => ({
  fetchNpmPackageTargetStatus: vi.fn(),
}));

vi.mock("../daemon/runtime-paths.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../daemon/runtime-paths.js")>()),
  resolveNodeRuntimeInfo,
}));

vi.mock("../infra/runtime-guard.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/runtime-guard.js")>()),
  nodeVersionSatisfiesEngine,
  parseSemver: (version: string | null) => {
    if (!version) {
      return null;
    }
    const match = version.match(/(\d+)\.(\d+)\.(\d+)/);
    if (!match) {
      return null;
    }
    return {
      major: Number.parseInt(match[1] ?? "0", 10),
      minor: Number.parseInt(match[2] ?? "0", 10),
      patch: Number.parseInt(match[3] ?? "0", 10),
    };
  },
}));

vi.mock("../infra/restart-stale-pids.js", () => ({
  getSelfAndAncestorPidsSync: () => mockGetSelfAndAncestorPidsSync(),
  terminateStaleGatewayPids: (...args: unknown[]) => terminateStaleGatewayPids(...args),
}));

vi.mock("../infra/update-managed-service-handoff-cleanup.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/update-managed-service-handoff-cleanup.js")>()),
  cleanupStaleManagedServiceUpdateHandoffs: vi.fn(async () => 0),
}));

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    execFile,
    spawn,
  };
});

vi.mock("../process/exec.js", async (importOriginal) => {
  const { createUpdateCommandTransportFixture, createUpdateUtf8CommandTransportFixture } =
    await import("./update-cli/update-command-transport.test-support.js");
  const actual = await importOriginal<typeof import("../process/exec.js")>();
  return {
    isPlainCommandExitFailure: actual.isPlainCommandExitFailure,
    // The real snapshot worker has separate WAL/source-inode boundary coverage.
    // Retain real rehearsal config projection and drift checks in this CLI fixture.
    runCommandBuffered: async (argv: string[], options: { input: string; timeoutMs?: number }) => {
      const input: unknown = JSON.parse(options.input);
      const mode = isRecord(input) ? input.mode : undefined;
      if (mode !== "inventory" && mode !== "snapshot") {
        throw new Error("Unexpected update state worker mode");
      }
      return {
        code: 0,
        stdout: Buffer.from(
          JSON.stringify(
            mode === "inventory"
              ? { databases: [], pluginBytes: 0, pluginPlan: "plugin-copy-plan.json" }
              : { versions: [], pluginPaths: {} },
          ),
        ),
        stderr: Buffer.alloc(0),
      };
    },
    runCommandWithTimeout: await createUpdateCommandTransportFixture({
      ...commandTransport,
      get npmPrefix() {
        return commandTransport.npmPrefix;
      },
      readServiceCommand: (env) => serviceReadCommand(env),
    }),
    runUtf8CommandWithTimeout: vi.fn(
      await createUpdateUtf8CommandTransportFixture(
        commandTransport,
        actual.runUtf8CommandWithTimeout,
      ),
    ),
    runExec: vi.fn(async () => ({
      stdout: new Date(Date.now() - 1000).toString(),
      stderr: "",
    })),
  };
});

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

vi.mock("../plugins/installed-plugin-index-records.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../plugins/installed-plugin-index-records.js")>();
  return {
    ...actual,
    loadInstalledPluginIndexInstallRecords,
    writePersistedInstalledPluginIndexInstallRecordsWithLease,
  };
});

vi.mock("../plugins/installed-plugin-index-store.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../plugins/installed-plugin-index-store.js")>();
  return {
    ...actual,
    readPersistedInstalledPluginIndex,
  };
});

vi.mock("../plugins/installed-plugin-index-store-write.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../plugins/installed-plugin-index-store-write.js")>();
  return {
    ...actual,
    restorePersistedInstalledPluginIndexIfCurrent,
  };
});

vi.mock("../commands/doctor/shared/post-core-plugin-convergence.js", () => ({
  runPostCorePluginConvergence: vi.fn(
    async (params: { cfg: OpenClawConfig; baselineInstallRecords?: unknown }) => ({
      config: params.cfg,
      configChanges: [],
      installedPluginIdRecovery: new Map(),
      changes: [],
      warnings: [],
      errored: false,
      smokeFailures: [],
      installRecords: params.baselineInstallRecords ?? {},
    }),
  ),
}));

vi.mock("../config/backup-rotation.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/backup-rotation.js")>()),
  createPreUpdateConfigSnapshot: (...args: unknown[]) => createPreUpdateConfigSnapshotMock(...args),
}));

vi.mock("../daemon/service.js", async () => {
  const { createUpdateServiceStateReader } =
    await import("./update-cli/update-command-service-state.test-support.js");
  return {
    readGatewayServiceState: createUpdateServiceStateReader({
      readCommand: (...args) => serviceReadCommand(...args),
      isLoaded: (...args) => serviceLoaded(...args),
      readRuntime: (...args) => serviceReadRuntime(...args),
      readCapability: () => serviceDefinitionMutationCapability(),
      absentPort: () => serviceFixtureState.absentServicePort,
    }),
    resolveGatewayService: vi.fn(() => ({
      isLoaded: (...args: unknown[]) => serviceLoaded(...args),
      isEnabled: (...args: unknown[]) => serviceEnabled(...args),
      readCommand: (...args: unknown[]) => serviceReadCommand(...args),
      readRuntime: (...args: unknown[]) => serviceReadRuntime(...args),
      start: (...args: unknown[]) => serviceStart(...args),
      stop: (...args: unknown[]) => serviceStop(...args),
      restart: (...args: unknown[]) => serviceRestart(...args),
    })),
  };
});

vi.mock("./update-cli/update-command-service-drain.js", () => ({
  withGatewayMaintenanceDrain: async (_params: unknown, stop: () => Promise<unknown>) =>
    await stop(),
}));
vi.mock("../daemon/systemd-maintenance.js", () => ({
  prepareSystemdGatewayMaintenance: systemdPolicy,
}));

vi.mock("../daemon/launchd.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../daemon/launchd.js")>()),
  disableCurrentOpenClawUpdateLaunchdJob:
    launchdUpdateCleanupMocks.disableCurrentOpenClawUpdateLaunchdJob,
}));

vi.mock("../daemon/schtasks.js", () => ({
  suspendScheduledTaskAutoStartForUpdate: (...args: unknown[]) =>
    suspendScheduledTaskAutoStartForUpdate(...args),
  resumeScheduledTaskAutoStartAfterUpdate: (...args: unknown[]) =>
    resumeScheduledTaskAutoStartAfterUpdate(...args),
}));

vi.mock("../daemon/schtasks-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../daemon/schtasks-runtime.js")>()),
  readWindowsStartupFallbackRuntimeForUpdate: windowsOfflineProbe,
}));

vi.mock("../infra/ports-inspect.js", () => ({
  inspectPortUsage: (...args: unknown[]) => inspectPortUsage(...args),
}));

vi.mock("../infra/ports-probe.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/ports-probe.js")>()),
  probePortUsage: (...args: unknown[]) => probePortUsage(...args),
}));

vi.mock("../infra/ports-format.js", () => ({
  classifyPortListener: (...args: unknown[]) => classifyPortListener(...args),
  formatPortDiagnostics: (...args: unknown[]) => formatPortDiagnostics(...args),
}));

vi.mock("../gateway/call.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../gateway/call.js")>()),
  callGateway: (opts: CallGatewayOptions) => callGateway(opts),
}));

vi.mock("./daemon-cli/restart-health.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./daemon-cli/restart-health.js")>();
  return {
    ...actual,
    waitForGatewayHttpReadiness: httpReadiness,
    waitForGatewayHealthyRestart: (
      ...args: Parameters<typeof actual.waitForGatewayHealthyRestart>
    ) =>
      restartHealthTestControl.snapshot === undefined
        ? actual.waitForGatewayHealthyRestart(...args)
        : Promise.resolve(
            restartHealthTestControl.snapshot as Awaited<
              ReturnType<typeof actual.waitForGatewayHealthyRestart>
            >,
          ),
  };
});

// Mock doctor (heavy module; should not run in unit tests)
vi.mock("../commands/doctor.js", () => ({
  doctorCommand: vi.fn(),
}));
vi.mock("../commands/doctor-completion.js", () => ({
  checkShellCompletionStatus: (...args: unknown[]) => checkShellCompletionStatus(...args),
  ensureCompletionCacheExists: (...args: unknown[]) => ensureCompletionCacheExists(...args),
}));
vi.mock("../commands/doctor/legacy-config-repair.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../commands/doctor/legacy-config-repair.js")>()),
  repairLegacyConfigForUpdateChannel: legacyConfigRepairMocks.repairLegacyConfigForUpdateChannel,
}));
vi.mock("./completion-runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./completion-runtime.js")>();
  return {
    ...actual,
    installCompletion: (...args: unknown[]) => installCompletion(...args),
  };
});
// Mock the daemon-cli module
vi.mock("./daemon-cli.js", () => ({
  runDaemonInstall: mockedRunDaemonInstall,
  runDaemonRestart: vi.fn(),
}));
vi.mock("./daemon-cli/install.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./daemon-cli/install.js")>()),
  runDaemonInstall: mockedRunDaemonInstall,
}));

// Mock the runtime
vi.mock("../runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../runtime.js")>()),
  defaultRuntime: runtimeCapture,
}));
vi.mock("../commands/triage.js", () => ({ triageCommand }));
vi.mock("../commands/triage-failure.js", () => ({ triageAfterFailure }));
vi.mock("./update-cli/update-command-report.js", () => updateFailureActionMocks);

export {
  callGateway,
  candidateValidation,
  checkShellCompletionStatus,
  classifyPortListener,
  commandTransport,
  confirm,
  createPreUpdateConfigSnapshotMock,
  databasePreflightMocks,
  ensureCompletionCacheExists,
  existingHostUri,
  fixtureEnvSnapshot,
  formatPortDiagnostics,
  gatewayFixturePid,
  httpReadiness,
  immutableHostUri,
  inferenceRepair,
  inspectPortUsage,
  installCompletion,
  launchdUpdateCleanupMocks,
  legacyConfigRepairMocks,
  loadInstalledPluginIndexInstallRecords,
  managedUpdateHandoff,
  mockGetSelfAndAncestorPidsSync,
  nodeVersionSatisfiesEngine,
  pathExists,
  pluginAvailabilityPreflight,
  probePortUsage,
  readPackageName,
  readPackageVersion,
  readPersistedInstalledPluginIndex,
  resetRuntimeCapture,
  resolveGlobalManager,
  resolveNodeRuntimeInfo,
  restartHealthTestControl,
  restorePersistedInstalledPluginIndexIfCurrent,
  resumeScheduledTaskAutoStartAfterUpdate,
  retainUpdateRuntime,
  runtimeCapture,
  select,
  serviceDefinitionMutationCapability,
  serviceEnabled,
  serviceFixtureState,
  serviceLoaded,
  serviceReadCommand,
  serviceReadRuntime,
  serviceRestart,
  serviceStart,
  serviceStop,
  sourceRuntimeCompletion,
  spawn,
  sqliteHostPlatform,
  stateSchemaVersions,
  suspendScheduledTaskAutoStartForUpdate,
  syncPluginsForUpdateChannel,
  systemdPolicy,
  terminateStaleGatewayPids,
  triageAfterFailure,
  triageCommand,
  unrelatedGatewayFixturePid,
  updateFailureActionMocks,
  updateNpmInstalledPlugins,
  windowsOfflineProbe,
  writePersistedInstalledPluginIndexInstallRecordsWithLease,
};

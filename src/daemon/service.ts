/** Platform service registry and shared gateway service start/repair logic. */
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { assertGatewayServiceMutationAllowed } from "../infra/gateway-supervision.js";
import { assertFutureConfigActionAllowed } from "./future-config-guard.js";
import {
  installLaunchAgent,
  isLaunchAgentEnabled,
  isLaunchAgentLoaded,
  readLaunchAgentProgramArguments,
  readLaunchAgentRuntime,
  restartLaunchAgent,
  startLaunchAgent,
  stageLaunchAgent,
  stopLaunchAgent,
  uninstallLaunchAgent,
} from "./launchd.js";
import {
  assertDaemonRuntimePinCurrent,
  assertDaemonRuntimePinDefinition,
  assertDaemonRuntimePinPlan,
  commitDaemonRuntimePin,
  readDaemonRuntimePinForInstall,
} from "./runtime-pin-state.js";
import {
  installScheduledTask,
  isScheduledTaskEnabled,
  isScheduledTaskInstalled,
  readScheduledTaskCommand,
  readScheduledTaskRuntime,
  restartScheduledTask,
  startScheduledTask,
  stageScheduledTask,
  stopScheduledTask,
  uninstallScheduledTask,
} from "./schtasks.js";
import { mergeGatewayServiceEnv } from "./service-env-merge.js";
import {
  ServiceInspectionError,
  ServiceOwnershipRefusalError,
  findServiceOwnershipRefusal,
} from "./service-inspection-error.js";
import {
  withGatewayServiceOperationLock,
  withSystemdServiceReadBinding,
} from "./service-operation-lock.js";
import { captureGatewayServiceRebind } from "./service-rebind.js";
import {
  createServiceRuntimeInspectionFailure,
  type GatewayServiceRuntime,
} from "./service-runtime.js";
import { collectGatewayServiceStartRepairIssues } from "./service-start-repair.js";
import type {
  GatewayServiceCommandConfig,
  GatewayServiceCommandInspection,
  GatewayServiceControlArgs,
  GatewayServiceEnv,
  GatewayServiceEnvArgs,
  GatewayServiceInstallArgs,
  GatewayServiceLoadState,
  GatewayServiceManageArgs,
  GatewayServiceReadOptions,
  GatewayServiceRestartResult,
  GatewayServiceStartRepairIssue,
  GatewayServiceStartResult,
  GatewayServiceStageArgs,
  GatewayServiceState,
} from "./service-types.js";
import {
  getGatewayServiceUpdateNativeCommand,
  withGatewayServiceUpdateAuthority,
} from "./service-update-authority.js";
import { readSystemdDefinitionMutationCapability } from "./systemd-definition-mutation.js";
import { admitSystemdServiceReadBinding } from "./systemd-peer.js";
import { findSystemdGatewayInstallation, isSystemdServiceAbsent } from "./systemd-scope.js";
import {
  findInstalledSystemdGatewayScope,
  installSystemdService,
  isSystemdServiceEnabled,
  readSystemdServiceExecStart,
  readSystemdServiceRuntime,
  restartSystemdService,
  startSystemdService,
  stageSystemdService,
  stopSystemdService,
  uninstallSystemdService,
} from "./systemd.js";
export { formatGatewayServiceStartRepairIssues } from "./service-start-repair.js";
export type {
  GatewayServiceCommandConfig,
  GatewayServiceInstallArgs,
  GatewayServiceStartRepairIssue,
  GatewayServiceState,
} from "./service-types.js";

// Platform service adapter used by CLI commands across launchd, systemd, and schtasks.
function ignoreServiceWriteResult<TArgs extends GatewayServiceInstallArgs>(
  write: (args: TArgs) => Promise<unknown>,
): (args: TArgs) => Promise<void> {
  return async (args: TArgs) => {
    await write(args);
  };
}

export type GatewayService = {
  label: string;
  loadedText: string;
  notLoadedText: string;
  /** Diagnostic guidance only; this does not establish service absence. */
  unsupportedReason?: string;
  stage: (args: GatewayServiceStageArgs) => Promise<void>;
  install: (args: GatewayServiceInstallArgs) => Promise<void>;
  uninstall: (args: GatewayServiceManageArgs) => Promise<void>;
  start: (args: GatewayServiceControlArgs) => Promise<void>;
  stop: (args: GatewayServiceControlArgs) => Promise<void>;
  restart: (args: GatewayServiceControlArgs) => Promise<GatewayServiceRestartResult>;
  isLoaded: (args: GatewayServiceEnvArgs) => Promise<boolean>;
  isEnabled?: (args: GatewayServiceEnvArgs) => Promise<boolean>;
  hasInstalledDefinition?: (args: GatewayServiceEnvArgs) => Promise<boolean>;
  isAbsent?: (args: GatewayServiceEnvArgs & { strictCommandAbsent?: true }) => Promise<boolean>;
  readDefinitionMutationCapability?: (
    args: GatewayServiceEnvArgs & {
      environment?: GatewayServiceEnv;
      requireLoaded?: boolean;
      systemdReadBinding?: GatewayServiceReadOptions["systemdReadBinding"];
      systemdReadTarget?: GatewayServiceReadOptions["systemdReadTarget"];
    },
  ) => ReturnType<typeof readSystemdDefinitionMutationCapability>;
  readCommand: (
    env: GatewayServiceEnv,
    opts?: GatewayServiceReadOptions,
  ) => Promise<GatewayServiceCommandConfig | null>;
  readRuntime: (
    env: GatewayServiceEnv,
    opts?: GatewayServiceReadOptions,
  ) => Promise<GatewayServiceRuntime>;
};

type ReadGatewayServiceStateArgs = GatewayServiceEnvArgs & {
  systemdReadTarget?: GatewayServiceReadOptions["systemdReadTarget"];
  systemdInstallation?: GatewayServiceState["systemdInstallation"];
  requireEffective?: boolean;
  requireLoadedCommand?: boolean;
  loadForInspection?: GatewayServiceReadOptions["loadForInspection"];
  systemdReadBinding?: GatewayServiceReadOptions["systemdReadBinding"];
  validateEnvBeforeStatusRead?: (env: GatewayServiceEnv) => void;
};

/** Reads the installed service and reports definition drift that must be repaired before launch. */
export async function inspectGatewayServiceStartRepair(
  service: GatewayService,
  args: GatewayServiceEnvArgs,
  expectedPort?: number,
): Promise<{ state: GatewayServiceState; issues: GatewayServiceStartRepairIssue[] }> {
  const state = await readGatewayServiceState(service, args);
  return { state, issues: collectGatewayServiceStartRepairIssues(state, expectedPort) };
}

export async function readGatewayServiceLoadState(
  service: GatewayService,
  args: GatewayServiceEnvArgs = {},
): Promise<GatewayServiceLoadState> {
  try {
    return { status: (await service.isLoaded(args)) ? "loaded" : "not-loaded" };
  } catch (error) {
    const refusal = findServiceOwnershipRefusal(error);
    if (refusal) {
      throw refusal;
    }
    return {
      status: "unknown",
      detail: String(error),
      ...(error instanceof ServiceInspectionError ? { inspectionReason: error.reason } : {}),
    };
  }
}

export async function readGatewayServiceState(
  service: GatewayService,
  input: ReadGatewayServiceStateArgs = {},
): Promise<GatewayServiceState> {
  let args = input;
  const baseEnv = args.env ?? (process.env as GatewayServiceEnv);
  if (service.readCommand === readSystemdServiceExecStart && !args.systemdReadTarget) {
    const installation = await findSystemdGatewayInstallation(baseEnv);
    if (installation.kind === "dueling" && args.requireEffective && args.requireLoadedCommand) {
      throw new ServiceOwnershipRefusalError("systemd-competing-managers");
    }
    const target =
      installation.kind === "system"
        ? installation.system
        : installation.kind === "user" || installation.kind === "dueling"
          ? installation.user
          : undefined;
    args = { ...args, systemdInstallation: installation, systemdReadTarget: target };
  }
  if (
    service.readCommand === readSystemdServiceExecStart &&
    args.systemdReadTarget?.scope !== "system" &&
    args.requireEffective &&
    args.requireLoadedCommand &&
    !args.systemdReadBinding
  ) {
    const deadline =
      performance.now() + (args.timeoutMs && args.timeoutMs > 0 ? args.timeoutMs : 5000);
    return await withSystemdServiceReadBinding(
      baseEnv,
      () => admitSystemdServiceReadBinding(baseEnv, deadline),
      (binding) => {
        const remaining = deadline - performance.now();
        if (remaining <= 0) {
          throw new ServiceInspectionError("systemd-inspection-deadline-exceeded");
        }
        return readGatewayServiceStateWithBinding(service, {
          ...args,
          systemdReadBinding: binding,
          timeoutMs: remaining,
        });
      },
      deadline,
    );
  }
  return await readGatewayServiceStateWithBinding(service, args);
}

async function readGatewayServiceStateWithBinding(
  service: GatewayService,
  args: ReadGatewayServiceStateArgs,
): Promise<GatewayServiceState> {
  const baseEnv = args.env ?? process.env;
  const { timeoutMs, systemdReadBinding, systemdReadTarget } = args;
  const deadline = performance.now() + (timeoutMs && timeoutMs > 0 ? timeoutMs : 5000);
  systemdReadBinding?.verify();
  let absent = await service.isAbsent?.({ env: baseEnv, timeoutMs }).catch(() => false);
  // Initial systemd absence proves no manager; strict absence below only proves no unit.
  const managerAbsent = absent && service.readCommand === readSystemdServiceExecStart;
  systemdReadBinding?.verify();
  let commandInspection: GatewayServiceCommandInspection | undefined;
  const command = absent
    ? null
    : args.requireEffective
      ? await service.readCommand(baseEnv, {
          timeoutMs,
          requireEffective: true,
          ...(!args.requireLoadedCommand
            ? {
                onCommandInspection: (inspection: GatewayServiceCommandInspection) => {
                  commandInspection = inspection;
                },
              }
            : {}),
          ...(systemdReadBinding ? { systemdReadBinding } : {}),
          ...(systemdReadTarget ? { systemdReadTarget } : {}),
          ...(args.requireLoadedCommand ? { requireLoaded: true } : {}),
          ...(args.loadForInspection ? { loadForInspection: args.loadForInspection } : {}),
        })
      : await service
          .readCommand(baseEnv, {
            timeoutMs,
            ...(systemdReadTarget ? { systemdReadTarget } : {}),
            onCommandInspection: (inspection) => {
              commandInspection = inspection;
            },
          })
          .catch((error: unknown) => {
            const refusal = findServiceOwnershipRefusal(error);
            if (refusal) {
              throw refusal;
            }
            return null;
          });
  const env = mergeGatewayServiceEnv(baseEnv, command);
  // Reject persisted selector drift before invoking the native service manager.
  args.validateEnvBeforeStatusRead?.(env);
  // Strict user-unit absence still needs the platform owner's system-scope proof.
  if (
    !absent &&
    service.isAbsent &&
    args.requireEffective &&
    args.requireLoadedCommand &&
    command === null
  ) {
    systemdReadBinding?.verify();
    const remaining = deadline - performance.now();
    if (remaining <= 0) {
      throw new ServiceInspectionError("systemd-inspection-deadline-exceeded");
    }
    absent = await service
      .isAbsent({ env, timeoutMs: remaining, strictCommandAbsent: true })
      .catch(() => false);
    systemdReadBinding?.verify();
    if (performance.now() >= deadline) {
      throw new ServiceInspectionError("systemd-inspection-deadline-exceeded");
    }
  }
  if (absent) {
    const inspectionReason = managerAbsent ? "service-manager-unavailable" : undefined;
    return {
      inspectionReason,
      installed: false,
      loadState: { status: "not-loaded" },
      running: false,
      env,
      command: null,
      runtime: { status: "stopped", missingUnit: true, inspectionReason },
    };
  }
  const readInstalled = async () =>
    command !== null
      ? true
      : (service.hasInstalledDefinition?.({ env, timeoutMs }).catch(() => false) ?? false);
  const readLoadState = () =>
    readGatewayServiceLoadState(service, { env: systemdReadBinding ? baseEnv : env, timeoutMs });
  const readRuntime = () =>
    service
      .readRuntime(env, {
        timeoutMs,
        ...(systemdReadTarget ? { systemdReadTarget } : {}),
        ...(commandInspection ? { commandInspection } : {}),
        ...(systemdReadBinding ? { systemdReadBinding } : {}),
        ...(args.requireEffective && args.requireLoadedCommand ? { requireLoaded: true } : {}),
        ...(args.loadForInspection ? { loadForInspection: args.loadForInspection } : {}),
      })
      .catch((error: unknown) => createServiceRuntimeInspectionFailure(error));
  // Update policy needs definition authority; ordinary status/start reads do not.
  const readDefinitionCapability = async () =>
    args.requireEffective
      ? service
          .readDefinitionMutationCapability?.({
            env: baseEnv,
            environment: env,
            timeoutMs,
            ...(systemdReadTarget ? { systemdReadTarget } : {}),
            ...(systemdReadBinding ? { systemdReadBinding } : {}),
            ...(args.requireLoadedCommand ? { requireLoaded: true } : {}),
          })
          .catch(() => ({ kind: "unknown", reason: "inspection-failed" }) as const)
      : undefined;
  // A delegated native child suspends the parent fence. Join each read before
  // another can use the parent's direct native peer; ordinary reads stay parallel.
  const [installed, loadState, runtime, definitionMutationCapability] =
    getGatewayServiceUpdateNativeCommand()
      ? ([
          await readInstalled(),
          await readLoadState(),
          await readRuntime(),
          await readDefinitionCapability(),
        ] as const)
      : await Promise.all([
          readInstalled(),
          readLoadState(),
          readRuntime(),
          readDefinitionCapability(),
        ]);
  systemdReadBinding?.verify();
  return {
    inspectionReason:
      runtime?.inspectionReason ??
      (loadState.status === "unknown" ? loadState.inspectionReason : undefined),
    ...(args.systemdInstallation ? { systemdInstallation: args.systemdInstallation } : {}),
    installed,
    loadState,
    running: runtime?.status === "running",
    env,
    command,
    ...(definitionMutationCapability ? { definitionMutationCapability } : {}),
    runtime,
  };
}

export async function startGatewayService(
  service: GatewayService,
  args: GatewayServiceControlArgs,
  expectedPort?: number,
): Promise<GatewayServiceStartResult> {
  const { state, issues: repairIssues } = await inspectGatewayServiceStartRepair(
    service,
    { env: args.env },
    expectedPort,
  );
  if (state.loadState.status === "unknown") {
    throw new Error(`Service status inspection failed: ${state.loadState.detail}`);
  }
  if (state.loadState.status === "not-loaded" && !state.installed) {
    return {
      outcome: "missing-install",
      state,
    };
  }

  if (state.loadState.status === "loaded" && state.running) {
    return {
      outcome: "already-running",
      state,
      issues: repairIssues,
    };
  }

  if (repairIssues.length > 0) {
    return {
      outcome: "repair-required",
      state,
      issues: repairIssues,
    };
  }

  let nextState: GatewayServiceState;
  try {
    await service.start({ ...args, env: state.env });
    nextState = await readGatewayServiceState(service, { env: state.env });
  } catch (err) {
    const recoveryState = await readGatewayServiceState(service, { env: state.env });
    if (!recoveryState.installed) {
      return {
        outcome: "missing-install",
        state: recoveryState,
      };
    }
    throw err;
  }

  if (nextState.loadState.status === "unknown") {
    throw new Error(`Service status inspection failed after start: ${nextState.loadState.detail}`);
  }
  const runtime = nextState.runtime;
  const failedState = normalizeLowercaseStringOrEmpty(runtime?.state) === "failed";
  const newFailedExit =
    runtime?.status === "stopped" &&
    typeof runtime.lastExitStatus === "number" &&
    runtime.lastExitStatus !== 0 &&
    runtime.lastExitStatus !== state.runtime?.lastExitStatus;
  if (failedState || newFailedExit) {
    const failure = failedState ? "state failed" : `exit ${runtime?.lastExitStatus}`;
    throw new Error(`Service failed to start (${failure}). Check the service logs and retry.`);
  }

  return {
    outcome: "started",
    state: nextState,
  };
}

export function describeGatewayServiceRestart(
  serviceNoun: string,
  result: GatewayServiceRestartResult,
): {
  scheduled: boolean;
  daemonActionResult: "restarted" | "scheduled";
  message: string;
  progressMessage: string;
} {
  if (result.outcome === "scheduled") {
    return {
      scheduled: true,
      daemonActionResult: "scheduled",
      message: `restart scheduled, ${normalizeLowercaseStringOrEmpty(serviceNoun)} will restart momentarily`,
      progressMessage: `${serviceNoun} service restart scheduled.`,
    };
  }
  return {
    scheduled: false,
    daemonActionResult: "restarted",
    message: `${serviceNoun} service restarted.`,
    progressMessage: `${serviceNoun} service restarted.`,
  };
}

type SupportedGatewayServicePlatform = "darwin" | "linux" | "win32";
type ServiceKind = "gateway" | "node";

function createUnsupportedGatewayServiceError(kind: ServiceKind): Error {
  if (process.platform === "freebsd") {
    if (kind === "node") {
      return new Error(
        "Node service management is not supported by this CLI on FreeBSD. " +
          "Run `openclaw node run` for a foreground node host connected to your Gateway.",
      );
    }
    return new Error(
      "Gateway service management is not supported by this CLI on FreeBSD. " +
        'For a pkg install, set openclaw_user to your onboarding account and openclaw_enable="YES" in /etc/rc.conf, ' +
        "then use `service openclaw start` (or stop/restart/status) as root. " +
        "For a foreground Gateway, run `openclaw gateway run` as your onboarding account.",
    );
  }
  return new Error(`Gateway service install not supported on ${process.platform}`);
}

function createUnsupportedGatewayService(kind: ServiceKind): GatewayService {
  // Node hosts share this adapter, but their recovery must never control the Gateway.
  const rejectUnsupportedGatewayService = async (): Promise<never> => {
    throw createUnsupportedGatewayServiceError(kind);
  };
  return {
    label: "Gateway service",
    loadedText: "available",
    notLoadedText: "not installed",
    unsupportedReason: createUnsupportedGatewayServiceError(kind).message,
    stage: rejectUnsupportedGatewayService,
    install: rejectUnsupportedGatewayService,
    uninstall: rejectUnsupportedGatewayService,
    start: rejectUnsupportedGatewayService,
    stop: rejectUnsupportedGatewayService,
    restart: rejectUnsupportedGatewayService,
    isLoaded: rejectUnsupportedGatewayService,
    readCommand: async () => null,
    readRuntime: async () => ({
      status: "unknown",
      detail: createUnsupportedGatewayServiceError(kind).message,
    }),
  };
}

const GATEWAY_SERVICE_REGISTRY: Record<SupportedGatewayServicePlatform, GatewayService> = {
  darwin: {
    label: "LaunchAgent",
    loadedText: "loaded",
    notLoadedText: "not loaded",
    stage: ignoreServiceWriteResult(stageLaunchAgent),
    install: ignoreServiceWriteResult(installLaunchAgent),
    uninstall: uninstallLaunchAgent,
    start: startLaunchAgent,
    stop: stopLaunchAgent,
    restart: restartLaunchAgent,
    isLoaded: isLaunchAgentLoaded,
    isEnabled: isLaunchAgentEnabled,
    readCommand: readLaunchAgentProgramArguments,
    readRuntime: readLaunchAgentRuntime,
  },
  linux: {
    label: "systemd",
    loadedText: "enabled",
    notLoadedText: "disabled",
    stage: ignoreServiceWriteResult(stageSystemdService),
    install: ignoreServiceWriteResult(installSystemdService),
    uninstall: uninstallSystemdService,
    start: startSystemdService,
    stop: stopSystemdService,
    restart: restartSystemdService,
    isLoaded: isSystemdServiceEnabled,
    isEnabled: isSystemdServiceEnabled,
    isAbsent: ({ env, timeoutMs, strictCommandAbsent }) =>
      isSystemdServiceAbsent(env ?? process.env, { timeoutMs, strictCommandAbsent }),
    hasInstalledDefinition: async ({ env }) =>
      (await findInstalledSystemdGatewayScope(env ?? process.env)) !== null,
    readDefinitionMutationCapability: ({
      env,
      environment,
      timeoutMs,
      requireLoaded,
      systemdReadBinding,
      systemdReadTarget,
    }) =>
      readSystemdDefinitionMutationCapability(env ?? process.env, {
        environment,
        timeoutMs,
        ...(systemdReadBinding ? { systemdReadBinding } : {}),
        ...(systemdReadTarget ? { systemdReadTarget } : {}),
        ...(requireLoaded ? { requireLoaded: true } : {}),
      }),
    readCommand: readSystemdServiceExecStart,
    readRuntime: readSystemdServiceRuntime,
  },
  win32: {
    label: "Scheduled Task",
    loadedText: "registered",
    notLoadedText: "missing",
    stage: ignoreServiceWriteResult(stageScheduledTask),
    install: ignoreServiceWriteResult(installScheduledTask),
    uninstall: uninstallScheduledTask,
    start: startScheduledTask,
    stop: stopScheduledTask,
    restart: restartScheduledTask,
    isLoaded: isScheduledTaskInstalled,
    isEnabled: isScheduledTaskEnabled,
    readCommand: readScheduledTaskCommand,
    readRuntime: readScheduledTaskRuntime,
  },
};

function guardGatewayServiceMutation<
  TArgs extends {
    env?: GatewayServiceEnv;
    assertCurrent?: () => void;
    beforeMutation?: () => Promise<void>;
  },
  TResult,
>(
  action: string,
  mutate: (args: TArgs) => Promise<TResult>,
  readCommand?: GatewayService["readCommand"],
  readRuntimePinRevision?: (env: GatewayServiceEnv) => string,
): (args: TArgs) => Promise<TResult> {
  return async (args) => {
    // Mutations must satisfy both lifecycle ownership and durable-config
    // version guards before invoking any platform service manager.
    assertGatewayServiceMutationAllowed(action, process.env);
    if (args.env && args.env !== process.env) {
      assertGatewayServiceMutationAllowed(action, args.env);
    }
    const assertCaller = args.assertCurrent;
    return await withGatewayServiceOperationLock(args.env ?? process.env, async (assertNative) => {
      await assertFutureConfigActionAllowed(action);
      return await withGatewayServiceUpdateAuthority(
        assertCaller,
        async (assertCurrent) => {
          await args.beforeMutation?.();
          assertCurrent();
          const result = readCommand
            ? await captureGatewayServiceRebind(
                () => readCommand(args.env ?? process.env, { requireEffective: true }),
                assertCurrent,
                (preserveAutoStart) =>
                  mutate({
                    ...args,
                    assertCurrent,
                    ...(preserveAutoStart ? { preserveAutoStart: true } : {}),
                  }),
                readRuntimePinRevision
                  ? () => readRuntimePinRevision(args.env ?? process.env)
                  : undefined,
              )
            : await mutate({ ...args, assertCurrent });
          assertCurrent();
          return result;
        },
        {
          updateOwned: false,
          assertRecoveryCurrent: assertNative,
          nativeCommand: getGatewayServiceUpdateNativeCommand(),
        },
      );
    });
  };
}

function withGatewayServiceMutationGuards(
  service: GatewayService,
  kind: ServiceKind,
): GatewayService {
  const write = (
    action: string,
    mutate: GatewayService["install"],
    readCommand?: GatewayService["readCommand"],
  ) =>
    guardGatewayServiceMutation(
      action,
      async (args: GatewayServiceInstallArgs) => {
        const scope = { kind, env: { ...args.env } };
        const update = args.runtimePinUpdate ?? {
          expected: readDaemonRuntimePinForInstall(scope, null, true),
        };
        // Pin-unaware callers cannot decide whether existing intent should survive a rewrite.
        if (!args.runtimePinUpdate && update.expected.stored) {
          throw new Error(
            "This service has explicit runtime intent. Reinstall with --runtime-path to preserve the pin or --runtime to choose a new runtime before rewriting it.",
          );
        }
        assertDaemonRuntimePinCurrent(scope, update.expected);
        if (update.pin || update.expected.stored) {
          const previous = await service.readCommand(args.env);
          args.assertCurrent?.();
          assertDaemonRuntimePinPlan(update.expected, previous);
          assertDaemonRuntimePinCurrent(scope, update.expected);
        }
        await mutate(args);
        if (update.pin || update.expected.stored) {
          const command = await service.readCommand(args.env);
          args.assertCurrent?.();
          assertDaemonRuntimePinDefinition(
            { programArguments: args.programArguments, workingDirectory: args.workingDirectory },
            command,
          );
          commitDaemonRuntimePin(scope, update, command);
        } else {
          assertDaemonRuntimePinCurrent(scope, update.expected);
        }
      },
      readCommand,
      (env) => readDaemonRuntimePinForInstall({ kind, env }, null, true).revision,
    );
  return {
    ...service,
    stage: write("rewrite the gateway service", service.stage),
    install: write("install or rewrite the gateway service", service.install, service.readCommand),
    uninstall: guardGatewayServiceMutation(
      "uninstall the gateway service",
      async (args: GatewayServiceManageArgs & { assertCurrent?: () => void }) => {
        const scope = { kind, env: { ...args.env } };
        const expected = readDaemonRuntimePinForInstall(scope, null, true);
        await service.uninstall(args);
        if (!expected.stored) {
          return;
        }
        const command = await service.readCommand(args.env);
        args.assertCurrent?.();
        if (command) {
          throw new Error("Service definition remains after uninstall; runtime pin retained.");
        }
        commitDaemonRuntimePin(scope, { expected }, null);
      },
    ),
    start: guardGatewayServiceMutation("start the gateway service", service.start),
    stop: guardGatewayServiceMutation("stop the gateway service", service.stop),
    restart: guardGatewayServiceMutation("restart the gateway service", service.restart),
  };
}

function isSupportedGatewayServicePlatform(
  platform: NodeJS.Platform,
): platform is SupportedGatewayServicePlatform {
  return Object.hasOwn(GATEWAY_SERVICE_REGISTRY, platform);
}

export function resolveGatewayService(kind: ServiceKind = "gateway"): GatewayService {
  if (isSupportedGatewayServicePlatform(process.platform)) {
    return withGatewayServiceMutationGuards(GATEWAY_SERVICE_REGISTRY[process.platform], kind);
  }
  return createUnsupportedGatewayService(kind);
}

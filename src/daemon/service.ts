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
import { readGatewayServiceCommandForMutation } from "./service-command-mutation.js";
import { withGatewayServiceOperationLock } from "./service-operation-lock.js";
import { captureGatewayServiceRebind } from "./service-rebind.js";
import { collectGatewayServiceStartRepairIssues } from "./service-start-repair.js";
import { readGatewayServiceState } from "./service-state.js";
import type {
  GatewayService,
  GatewayServiceControlArgs,
  GatewayServiceEnv,
  GatewayServiceEnvArgs,
  GatewayServiceInstallArgs,
  GatewayServiceManageArgs,
  GatewayServiceStartRepairIssue,
  GatewayServiceStartResult,
  GatewayServiceState,
} from "./service-types.js";
import {
  getGatewayServiceUpdateNativeCommand,
  withGatewayServiceUpdateAuthority,
} from "./service-update-authority.js";
import { readSystemdDefinitionMutationCapability } from "./systemd-definition-mutation.js";
import { isSystemdServiceAbsent } from "./systemd-scope.js";
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
export { readGatewayServiceCommandForMutation } from "./service-command-mutation.js";
export { describeGatewayServiceRestart } from "./service-restart-result.js";
export { formatGatewayServiceStartRepairIssues } from "./service-start-repair.js";
export { readGatewayServiceState } from "./service-state.js";
export type {
  GatewayService,
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

/** Reads the installed service and reports definition drift that must be repaired before launch. */
export async function inspectGatewayServiceStartRepair(
  service: GatewayService,
  args: GatewayServiceEnvArgs,
  expectedPort?: number,
): Promise<{ state: GatewayServiceState; issues: GatewayServiceStartRepairIssue[] }> {
  const state = await readGatewayServiceState(service, args);
  return { state, issues: collectGatewayServiceStartRepairIssues(state, expectedPort) };
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

type SupportedGatewayServicePlatform = "darwin" | "linux" | "win32";
type ServiceKind = "gateway" | "node";

function describeUnsupportedGatewayService(kind: ServiceKind): string {
  if (process.platform === "freebsd") {
    if (kind === "node") {
      return (
        "Node service management is not supported by this CLI on FreeBSD. " +
        "Run `openclaw node run` for a foreground node host connected to your Gateway."
      );
    }
    return (
      "Gateway service management is not supported by this CLI on FreeBSD. " +
      'For a pkg install, set openclaw_user to your onboarding account and openclaw_enable="YES" in /etc/rc.conf, ' +
      "then use `service openclaw start` (or stop/restart/status) as root. " +
      "For a foreground Gateway, run `openclaw gateway run` as your onboarding account."
    );
  }
  return `Gateway service install not supported on ${process.platform}`;
}

function createUnsupportedGatewayService(kind: ServiceKind): GatewayService {
  const unsupportedReason = describeUnsupportedGatewayService(kind);
  // Node hosts share this adapter, but their recovery must never control the Gateway.
  const rejectUnsupportedGatewayService = async (): Promise<never> => {
    throw new Error(unsupportedReason);
  };
  return {
    label: "Gateway service",
    loadedText: "available",
    notLoadedText: "not installed",
    unsupportedReason,
    stage: rejectUnsupportedGatewayService,
    install: rejectUnsupportedGatewayService,
    uninstall: rejectUnsupportedGatewayService,
    start: rejectUnsupportedGatewayService,
    stop: rejectUnsupportedGatewayService,
    restart: rejectUnsupportedGatewayService,
    isLoaded: rejectUnsupportedGatewayService,
    readCommand: async () => null,
    readRuntime: async () => ({ status: "unknown", detail: unsupportedReason }),
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
    hasInstalledDefinition: async ({ env, timeoutMs }) =>
      (await findInstalledSystemdGatewayScope(env ?? process.env, { timeoutMs })) !== null,
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
          const { command: previous } = await readGatewayServiceCommandForMutation(
            service,
            args.env,
          );
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

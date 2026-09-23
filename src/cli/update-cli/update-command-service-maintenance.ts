// Managed service identity, shutdown, and recovery shared by update and Doctor.
import { Writable } from "node:stream";
import { theme } from "../../../packages/terminal-core/src/theme.js";
import { isGatewayServiceEnv } from "../../daemon/constants.js";
import { ScheduledTaskAutoStartRecoveryError } from "../../daemon/schtasks-update-recovery.js";
import {
  ServiceInspectionError,
  findServiceOwnershipRefusal,
} from "../../daemon/service-inspection-error.js";
import { resolveManagedServiceNodeRunner } from "../../daemon/service-layout.js";
import { withGatewayServiceOperationLock } from "../../daemon/service-operation-lock.js";
import {
  resolveManagedGatewayServiceCommand,
  type GatewayServiceState,
} from "../../daemon/service-types.js";
import { readGatewayServiceState, resolveGatewayService } from "../../daemon/service.js";
import { readSystemdServiceExecStart } from "../../daemon/systemd-service-files.js";
import { captureSystemdServiceIdentity } from "../../daemon/systemd-service-identity.js";
import { parseTcpPortFromArgs } from "../../infra/tcp-port.js";
import { UPDATE_RUN_ID_ENV } from "../../infra/update-control-plane-sentinel.js";
import { admitSystemdUpdate } from "../../infra/update-managed-service-handoff-service.js";
import { isCurrentManagedServiceUpdateHandoffProcess } from "../../infra/update-managed-service-handoff.js";
import {
  getUpdateRun,
  recordUpdateRunPhase,
  recordUpdateRunStep,
} from "../../infra/update-run-ledger.js";
import { hasCommandProcessCleanupError } from "../../process/exec-result.js";
import { withCommandProcessScope } from "../../process/exec-spawn.js";
import { defaultRuntime } from "../../runtime.js";
import { UpdatePreMutationError, type UpdateCommandOptions } from "./shared.js";
import { gatewayMaintenanceBlockMessage } from "./update-command-handoff.js";
import { updateCommandLedgerOptions } from "./update-command-ledger.js";
import { UpdateCommandRecoveryPendingError } from "./update-command-recovery-error.js";
import type {
  ManagedGatewayUpdateVerdict,
  PreManagedServiceStop,
} from "./update-command-service-context-types.js";
import {
  assertGatewayServiceAdmissionUnchanged,
  assertGatewayServiceManagementAllowedForUpdate,
  GATEWAY_SERVICE_INSPECTION_WARNING,
  GatewayServiceUpdateOwnershipError,
  observedSystemdManagerUid,
  resolveGatewayServiceManagementBlockMessageForUpdate,
} from "./update-command-service-plan.js";
import { isManagedGatewayServiceOffline } from "./update-command-service-publication.js";
import { revalidateManagedGatewayServiceAfterUpdate } from "./update-command-service-revalidation.js";
import {
  createWindowsTaskAutoStartRecovery,
  UpdateCommandAbort,
  type WindowsTaskAutoStartRecovery,
} from "./update-command-windows-task.js";

export { withGatewayRuntimeArtifactPublication } from "./update-command-service-publication.js";
// Doctor primes this module before package replacement and reuses it during restoration.
export { revalidateManagedGatewayServiceAfterUpdate } from "./update-command-service-revalidation.js";
export type { PreManagedServiceStop } from "./update-command-service-context-types.js";
export { UpdateCommandAbort } from "./update-command-windows-task.js";

const JSON_MODE_SERVICE_STDOUT = new Writable({
  write(_chunk, _encoding, callback) {
    callback();
  },
});

export type UpdateCommandRecoveryState = {
  windowsTaskAutoStartRecovery?: WindowsTaskAutoStartRecovery;
  ledgerHandoffOwned?: boolean;
  /** Local completion evidence only; never grants access to migrated canonical state. */
  ledgerHandoffCompleted?: boolean;
  triageTarget: import("./update-command-triage.js").UpdateTriageTarget;
};

export function createWindowsTaskAutoStartGuard(params: {
  root: string;
  before: Pick<PreManagedServiceStop, "serviceEnv" | "serviceUpdateVerdict" | "serviceManagerUid">;
  timeoutMs?: number;
}): () => Promise<void> {
  const before = params.before;
  return async () => {
    const state = await readGatewayServiceState(resolveGatewayService(), {
      env: before.serviceEnv,
      requireEffective: true,
      requireLoadedCommand: true,
      validateEnvBeforeStatusRead: assertGatewayServiceManagementAllowedForUpdate,
      timeoutMs: params.timeoutMs,
    });
    const verdict = await revalidateManagedGatewayServiceAfterUpdate({
      state,
      root: params.root,
      preManagedServiceStop: before,
      allowInstallRootChange: true,
    });
    if (verdict.kind !== "owned" && verdict.kind !== "unresolved") {
      throw new GatewayServiceUpdateOwnershipError(
        "Windows task ownership could not be verified; inspect its autostart state manually.",
        undefined,
      );
    }
  };
}

async function maybeSuspendWindowsTaskAutoStartForUpdate(params: {
  serviceEnv: NodeJS.ProcessEnv | undefined;
  assertCurrentService?: () => Promise<void>;
  assertCurrent?: () => void;
  updateRun?: UpdateCommandOptions["run"];
}): Promise<WindowsTaskAutoStartRecovery | undefined> {
  if (process.platform !== "win32" || !params.serviceEnv) {
    return undefined;
  }
  const recovery = createWindowsTaskAutoStartRecovery({
    ...params,
    serviceEnv: params.serviceEnv,
  });
  let suspended: boolean;
  try {
    suspended = await recovery.suspended;
  } catch (err) {
    await recovery.restore().catch(() => undefined);
    await recovery.complete(!(err instanceof ScheduledTaskAutoStartRecoveryError));
    throw err;
  }
  await abortWindowsTaskUpdateIfInterrupted(recovery);
  if (!suspended) {
    try {
      await recovery.restore();
    } finally {
      await recovery.complete();
    }
    return undefined;
  }
  return recovery;
}

async function abortWindowsTaskUpdateIfInterrupted(
  recovery: WindowsTaskAutoStartRecovery,
): Promise<void> {
  if (!recovery.interrupted()) {
    return;
  }
  try {
    await recovery.restore();
  } finally {
    await recovery.complete();
  }
  throw new UpdateCommandAbort();
}

export async function maybeResumeWindowsTaskAutoStartAfterPackageUpdate(
  stopState: PreManagedServiceStop | undefined,
  restartSafe?: boolean,
  guard?: () => Promise<void>,
  assertCurrent?: () => void,
): Promise<void> {
  if (!stopState?.windowsTaskAutoStartRecovery) {
    return;
  }
  // Activation needs an enabled task; retain its owner until verification can
  // commit that restoration or compensate a failed update.
  await stopState.windowsTaskAutoStartRecovery.restore(restartSafe, guard, assertCurrent);
}

type ManagedServiceStopParams = {
  recovery?: unknown;
  updateRun?: UpdateCommandOptions["run"];
  updateInstallKind: "git" | "package";
  root: string;
  shouldRestart: boolean;
  jsonMode: boolean;
  phase?: "inspect" | "prepare" | "refresh";
  /** Package/helper root can differ from the inspected service during a rebind. */
  handoffRoot?: string;
  handoffFromGateway?: (state: GatewayServiceState) => Promise<boolean>;
  expectedService?: Pick<
    PreManagedServiceStop,
    "serviceEnv" | "serviceUpdateVerdict" | "serviceManagerUid"
  >;
  allowInstallRootChange?: boolean;
  onStopped?: (state: PreManagedServiceStop) => void;
  /** Doctor restores this same native instance after its offline repair. */
  retainNativeIdentity?: boolean;
  assertCurrent?: () => void;
  timeoutMs?: number;
  warn?: (message: string) => void;
};

function unavailableServiceState(
  verdict: Extract<ManagedGatewayUpdateVerdict, { kind: "unavailable" }>,
): PreManagedServiceStop {
  // Unverified records supply diagnostics, never selectors or later native authority.
  return {
    stopped: false,
    inspected: false,
    runtimeInspected: false,
    running: false,
    serviceMutationAllowed: false,
    serviceUpdateVerdict: verdict,
    serviceMutationSkipMessage: verdict.message,
  };
}

export async function maybeStopManagedServiceBeforeMutableUpdate(
  params: ManagedServiceStopParams,
): Promise<PreManagedServiceStop> {
  if (params.recovery) {
    throw new UpdateCommandRecoveryPendingError(
      "Full-state checkpoint recovery is deferred; retained state was left unchanged.",
    );
  }
  const expected = params.expectedService?.serviceUpdateVerdict;
  if (expected?.kind === "unavailable") {
    return unavailableServiceState(expected);
  }
  if (params.phase === "inspect") {
    return await stopManagedServiceBeforeMutableUpdate(params);
  }
  return await withGatewayServiceOperationLock(
    params.expectedService?.serviceEnv ?? process.env,
    (assertNative) => stopManagedServiceBeforeMutableUpdate(params, assertNative),
  );
}

async function stopManagedServiceBeforeMutableUpdate(
  params: ManagedServiceStopParams,
  assertNative?: () => void,
): Promise<PreManagedServiceStop> {
  // Retain the original live owner across daemon awaits; history is not authority.
  const updateRun = params.updateRun;
  const executorFence = updateRun?.executorFence;
  const assertExecutor = () => {
    if (params.updateRun !== updateRun || updateRun?.executorFence !== executorFence) {
      throw new Error("Native preparation lost its original update executor.");
    }
    executorFence?.assertCurrent();
  };
  const assertCurrent = () => {
    params.assertCurrent?.();
    assertNative?.();
    assertExecutor();
  };
  let warningIndex = 0;
  const warn = (message: string) => {
    assertCurrent();
    (params.warn ?? defaultRuntime.error)(message);
    const runId = updateRun?.runId ?? process.env[UPDATE_RUN_ID_ENV];
    if (runId) {
      try {
        recordUpdateRunStep(
          runId,
          {
            step: `warning:gateway-maintenance:${Date.now()}:${warningIndex++}`,
            status: "completed",
            endedAtMs: Date.now(),
            detail: message,
          },
          updateRun ? updateCommandLedgerOptions(updateRun) : { env: undefined },
        );
      } catch {
        (params.warn ?? defaultRuntime.error)(
          "Could not record the Gateway maintenance warning in update history.",
        );
      }
    }
  };
  // Detached helpers can retain Gateway ancestry or inherited service metadata.
  // Reprove their current handoff lease at every boundary that can stop the Gateway.
  const resolveAncestryBlock = async (state: GatewayServiceState) => {
    const blockMessage = gatewayMaintenanceBlockMessage(state, params.root);
    if (
      !blockMessage ||
      (await isCurrentManagedServiceUpdateHandoffProcess({
        root: params.handoffRoot ?? params.root,
        runId: params.updateRun?.runId,
      }))
    ) {
      return undefined;
    }
    return blockMessage;
  };
  assertCurrent();
  const uninspected = { stopped: false, inspected: false, runtimeInspected: false, running: false };
  // Preparation must keep using the manager route admitted during inspection.
  // Re-reading through process.env can select a different raw systemd route
  // (for example after the service snapshot fills in an explicit unit/profile),
  // which invalidates the retained native binding before activation.
  const serviceEnv = params.expectedService?.serviceEnv ?? process.env;
  const serviceMutationSkipMessage =
    resolveGatewayServiceManagementBlockMessageForUpdate(serviceEnv);
  if (serviceMutationSkipMessage) {
    return { ...uninspected, serviceMutationAllowed: false, serviceMutationSkipMessage };
  }
  let service: ReturnType<typeof resolveGatewayService> | undefined;
  let serviceState: GatewayServiceState;
  try {
    const inspectedService = resolveGatewayService();
    service = inspectedService;
    serviceState = await withCommandProcessScope(() =>
      readGatewayServiceState(inspectedService, {
        env: serviceEnv,
        requireEffective: true,
        requireLoadedCommand: true,
        validateEnvBeforeStatusRead: assertGatewayServiceManagementAllowedForUpdate,
        timeoutMs: params.timeoutMs,
      }),
    );
    if (
      process.platform === "win32" &&
      serviceState.runtime?.inspectionFailure?.timeoutMs !== undefined
    ) {
      // Re-read the definition too: a timed-out snapshot cannot grant service ownership.
      serviceState = await withCommandProcessScope(() =>
        readGatewayServiceState(inspectedService, {
          env: serviceEnv,
          requireEffective: true,
          validateEnvBeforeStatusRead: assertGatewayServiceManagementAllowedForUpdate,
          timeoutMs: params.timeoutMs,
        }),
      );
    }
  } catch (err) {
    if (hasCommandProcessCleanupError(err)) {
      throw err;
    }
    assertCurrent();
    if (err instanceof GatewayServiceUpdateOwnershipError && service) {
      const inspectedService = service;
      const available = await withCommandProcessScope(() =>
        inspectedService.isLoaded({ env: serviceEnv, timeoutMs: params.timeoutMs }),
      ).then(
        () => true,
        (error: unknown) => {
          if (hasCommandProcessCleanupError(error)) {
            throw error;
          }
          return false;
        },
      );
      assertCurrent();
      if (available) {
        return { ...uninspected, serviceMutationAllowed: false, blockMessage: err.message };
      }
    }
    return unavailableServiceState({
      kind: "unavailable",
      message:
        err instanceof ServiceInspectionError || err instanceof GatewayServiceUpdateOwnershipError
          ? `${GATEWAY_SERVICE_INSPECTION_WARNING} ${err.message}`
          : GATEWAY_SERVICE_INSPECTION_WARNING,
      ...(err instanceof ServiceInspectionError ? { inspectionReason: err.reason } : {}),
    });
  }
  assertCurrent();
  const serviceUpdateVerdict = await withCommandProcessScope(() =>
    revalidateManagedGatewayServiceAfterUpdate({
      root: params.root,
      state: serviceState,
      preManagedServiceStop: params.expectedService,
      allowInstallRootChange:
        params.allowInstallRootChange ?? params.updateInstallKind === "package",
    }),
  );
  assertCurrent();
  if (params.phase) {
    // Admission pins the definition; post-update ownership permits authorized refresh.
    assertGatewayServiceAdmissionUnchanged(params.expectedService, serviceUpdateVerdict);
  }
  if (serviceUpdateVerdict.kind === "unavailable") {
    return unavailableServiceState(serviceUpdateVerdict);
  }
  const inspected: PreManagedServiceStop = {
    stopped: false,
    inspected: true,
    runtimeInspected: ["running", "stopped"].includes(serviceState.runtime?.status ?? ""),
    running: serviceState.running,
    ...(typeof serviceState.runtime?.pid === "number"
      ? { servicePid: serviceState.runtime.pid }
      : {}),
    offline: await withCommandProcessScope(() => isManagedGatewayServiceOffline(serviceState)),
    serviceEnv: serviceState.env,
    serviceDefinitionEnv:
      resolveManagedGatewayServiceCommand(serviceState.command)?.environment ?? {},
    serviceNodeRunner: resolveManagedServiceNodeRunner(serviceState.command),
    servicePort: parseTcpPortFromArgs(serviceState.command?.programArguments) ?? undefined,
    ...(process.platform === "linux"
      ? { serviceManagerUid: observedSystemdManagerUid(serviceState) }
      : {}),
    serviceUpdateVerdict,
  };
  assertCurrent();
  if (serviceUpdateVerdict.kind === "foreign") {
    return {
      ...inspected,
      serviceMutationAllowed: false,
      serviceMutationSkipMessage:
        "Gateway service management skipped: the service belongs to a different OpenClaw installation and was left untouched.",
    };
  }
  if (serviceUpdateVerdict.kind === "absent") {
    return {
      ...inspected,
      serviceMutationAllowed: false,
      serviceMutationSkipMessage:
        "Gateway restart skipped: no Gateway service or listener is running.",
    };
  }
  const operatorRestartWarning =
    process.env.OPENCLAW_UPDATE_IN_PROGRESS === "1" && serviceUpdateVerdict.kind === "owned"
      ? await admitSystemdUpdate(
          params.root,
          serviceState.env,
          serviceState.systemdInstallation ?? null,
        )
      : undefined;
  assertCurrent();
  // Pure inventory inspection supplies no handoff callback. Execution supplies it
  // only after complete target admission, before online candidate validation.
  if (params.shouldRestart && serviceState.running && params.handoffFromGateway) {
    const blockMessage = gatewayMaintenanceBlockMessage(serviceState, params.root, "handoff");
    if (blockMessage) {
      return { ...inspected, blockMessage };
    }
    if (await params.handoffFromGateway(serviceState)) {
      throw new UpdateCommandAbort();
    }
  }
  if (operatorRestartWarning) {
    return {
      ...inspected,
      serviceMutationAllowed: false,
      serviceMutationSkipMessage: operatorRestartWarning,
    };
  }
  if (params.phase === "inspect") {
    const blockMessage = params.handoffFromGateway
      ? await resolveAncestryBlock(serviceState)
      : undefined;
    return blockMessage ? { ...inspected, blockMessage } : inspected;
  }
  const suspendTask = async () => {
    return await maybeSuspendWindowsTaskAutoStartForUpdate({
      serviceEnv: serviceState.env,
      updateRun,
      assertCurrentService: createWindowsTaskAutoStartGuard({
        root: params.root,
        before: inspected,
        timeoutMs: params.timeoutMs,
      }),
      assertCurrent: () => {
        // Recovery reacquires its native lock, but retains the caller's authority.
        params.assertCurrent?.();
        assertExecutor();
        if (
          updateRun &&
          getUpdateRun(updateRun.runId, { env: updateRun.env })?.status !== "running"
        ) {
          throw new Error("Update run no longer owns Windows task activation.");
        }
      },
    });
  };
  // A loaded LaunchAgent can be between KeepAlive respawns. Other supervisors
  // need the handoff marker to distinguish that transition from operator-stopped state.
  const supervisorMayRespawn =
    params.shouldRestart &&
    serviceState.loadState.status === "loaded" &&
    (process.platform === "darwin"
      ? (await service.isEnabled?.({ env: serviceState.env, timeoutMs: params.timeoutMs })) === true
      : process.env.OPENCLAW_UPDATE_RUN_HANDOFF === "1");
  assertCurrent();
  if (
    params.phase === "refresh" ||
    !params.shouldRestart ||
    (!serviceState.running && !supervisorMayRespawn)
  ) {
    if (process.platform === "linux" && serviceUpdateVerdict.kind === "owned") {
      const { prepareSystemdGatewayMaintenance } =
        await import("../../daemon/systemd-maintenance.js");
      await prepareSystemdGatewayMaintenance({
        state: serviceState,
        root: params.root,
        stopping: false,
        assertCurrent,
        warn,
      });
    }
    if (params.phase === "refresh") {
      return inspected;
    }
    if (!params.shouldRestart && !params.jsonMode && serviceState.running) {
      const warning = `--no-restart is set while the managed gateway service is running; the ${params.updateInstallKind} update will not stop or restart that process.`;
      defaultRuntime.log(theme.warn(warning));
    }
    const windowsTaskAutoStartRecovery =
      !params.shouldRestart && isGatewayServiceEnv(process.env) ? undefined : await suspendTask();
    return {
      ...inspected,
      ...(windowsTaskAutoStartRecovery ? { windowsTaskAutoStartRecovery } : {}),
    };
  }
  const blockMessage = await resolveAncestryBlock(serviceState);
  if (blockMessage) {
    return { ...inspected, blockMessage };
  }

  if (!params.jsonMode) {
    const message = `Stopping managed gateway service before ${params.updateInstallKind} update...`;
    defaultRuntime.log(theme.muted(message));
  }
  const windowsTaskAutoStartRecovery = await suspendTask();
  let stoppedAtMs: number | undefined;
  try {
    // Ownership inspection and native preparation await work. Recheck the exact
    // launcher before stopping so a replacement service cannot inherit authority.
    const readCurrentService = async (env: NodeJS.ProcessEnv) => {
      const state = await readGatewayServiceState(service, {
        env,
        requireEffective: true,
        requireLoadedCommand: true,
        validateEnvBeforeStatusRead: assertGatewayServiceManagementAllowedForUpdate,
        timeoutMs: params.timeoutMs,
      });
      const verdict = await revalidateManagedGatewayServiceAfterUpdate({
        state,
        root: params.root,
        preManagedServiceStop: inspected,
        allowInstallRootChange: params.allowInstallRootChange,
      });
      assertGatewayServiceAdmissionUnchanged(inspected, verdict);
      assertCurrent();
      return state;
    };
    let currentState = await readCurrentService(serviceState.env);
    const currentBlockMessage = await resolveAncestryBlock(currentState);
    if (currentBlockMessage) {
      throw new UpdatePreMutationError("managed-service-preflight", currentBlockMessage);
    }
    if (process.platform === "linux") {
      const { prepareSystemdGatewayMaintenance } =
        await import("../../daemon/systemd-maintenance.js");
      const refreshed = await prepareSystemdGatewayMaintenance({
        state: currentState,
        root: params.root,
        stopping: true,
        assertCurrent,
        warn,
      });
      if (refreshed) {
        // Policy refresh preserves the launcher; retain admitted installation drift.
        currentState = await readCurrentService(currentState.env);
      }
    }
    if (
      params.retainNativeIdentity &&
      process.platform === "linux" &&
      service.readCommand === readSystemdServiceExecStart
    ) {
      const installation = currentState.systemdInstallation;
      const target =
        installation?.kind === "system"
          ? installation.system
          : installation?.kind === "user" || installation?.kind === "dueling"
            ? installation.user
            : undefined;
      if (!target) {
        throw new Error("The systemd service identity could not be captured before stopping.");
      }
      try {
        inspected.serviceSystemdIdentity = await captureSystemdServiceIdentity({
          env: currentState.env,
          target: { ...target, unitPath: currentState.command?.sourcePath ?? target.unitPath },
          managerUid: observedSystemdManagerUid(currentState),
          timeoutMs: params.timeoutMs,
        });
      } catch (error) {
        assertCurrent();
        if (hasCommandProcessCleanupError(error) || findServiceOwnershipRefusal(error)) {
          throw error;
        }
        const message = `Gateway restoration identity could not be inspected; the managed service was not stopped. ${error instanceof ServiceInspectionError ? error.message : "Run openclaw gateway status --deep to inspect the native service manager."}`;
        return {
          ...inspected,
          serviceMutationAllowed: false,
          serviceMutationSkipMessage: message,
          serviceUpdateVerdict: { kind: "unavailable", message },
        };
      }
      assertCurrent();
    }
    const stop = async () => {
      assertCurrent();
      if (process.platform === "linux") {
        const beforeStop = await readCurrentService(currentState.env);
        if (beforeStop.runtime?.pid !== currentState.runtime?.pid) {
          throw new GatewayServiceUpdateOwnershipError(
            "Gateway process changed during maintenance drain; inspect its service before retrying.",
            undefined,
          );
        }
      }
      stoppedAtMs = Date.now();
      if (params.updateRun) {
        recordUpdateRunPhase(
          params.updateRun.runId,
          "activating",
          undefined,
          updateCommandLedgerOptions(params.updateRun),
        );
      }
      await service.stop({
        env: currentState.env,
        stdout: params.jsonMode ? JSON_MODE_SERVICE_STDOUT : process.stdout,
        assertCurrent,
        ...(updateRun
          ? { updateHandoff: { root: params.handoffRoot ?? params.root, runId: updateRun.runId } }
          : {}),
        // Native stop may unload the service before a later port check fails.
        onMutation: () => params.onStopped?.({ ...inspected, stopped: true, stoppedAtMs }),
      });
    };
    if (process.platform === "linux") {
      const { withGatewayMaintenanceDrain } = await import("./update-command-service-drain.js");
      await withGatewayMaintenanceDrain(
        {
          state: currentState,
          timeoutMs: params.timeoutMs ?? updateRun?.defaultStepTimeoutMs,
          assertCurrent,
          warn,
        },
        stop,
      );
    } else {
      await stop();
    }
    assertCurrent();
    if (windowsTaskAutoStartRecovery) {
      await abortWindowsTaskUpdateIfInterrupted(windowsTaskAutoStartRecovery);
    }
  } catch (err) {
    try {
      assertCurrent();
    } catch (cause) {
      throw new AggregateError([err, cause], "Update executor was lost during native preparation", {
        cause,
      });
    }
    if (err instanceof UpdateCommandAbort) {
      throw err;
    }
    if (windowsTaskAutoStartRecovery) {
      let autostartRestored = false;
      try {
        await windowsTaskAutoStartRecovery.restore();
        autostartRestored = true;
      } catch (resumeErr) {
        throw new ScheduledTaskAutoStartRecoveryError(
          [err, resumeErr],
          `Failed to stop the managed gateway (${String(err)}) and restore Windows Scheduled Task autostart (${String(resumeErr)})`,
          serviceState.env,
        );
      } finally {
        await windowsTaskAutoStartRecovery.complete(autostartRestored);
      }
      if (windowsTaskAutoStartRecovery.interrupted()) {
        throw new UpdateCommandAbort();
      }
    }
    throw err;
  }
  return {
    ...inspected,
    stopped: true,
    stoppedAtMs,
    ...(windowsTaskAutoStartRecovery ? { windowsTaskAutoStartRecovery } : {}),
  };
}

export function shouldBlockMutableUpdateFromGatewayServiceEnv(params: {
  preManagedServiceStop: PreManagedServiceStop | undefined;
}): boolean {
  const stopState = params.preManagedServiceStop;
  return (
    stopState?.serviceUpdateVerdict?.kind !== "unavailable" &&
    isGatewayServiceEnv(process.env) &&
    (!stopState?.inspected ||
      (!stopState.stopped &&
        (!stopState.runtimeInspected || (stopState.running && !stopState.blockMessage))))
  );
}

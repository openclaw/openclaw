// Managed service identity, shutdown, and recovery shared by update and Doctor.
import { Writable } from "node:stream";
import { stableStringify } from "@openclaw/normalization-core/stable-stringify";
import { theme } from "../../../packages/terminal-core/src/theme.js";
import { isGatewayServiceEnv, resolveGatewayProfileSuffix } from "../../daemon/constants.js";
import { resolveLaunchAgentLabel } from "../../daemon/launchd-label.js";
import { resolveTaskName } from "../../daemon/schtasks-layout.js";
import {
  isScheduledTaskDefinitelyNotRunning,
  readWindowsStartupFallbackRuntimeForUpdate,
} from "../../daemon/schtasks-runtime.js";
import { ScheduledTaskAutoStartRecoveryError } from "../../daemon/schtasks-update-recovery.js";
import { withGatewayServiceOperationLock } from "../../daemon/service-operation-lock.js";
import {
  resolveManagedGatewayServiceCommand,
  type GatewayServiceState,
} from "../../daemon/service-types.js";
import { readGatewayServiceState, resolveGatewayService } from "../../daemon/service.js";
import { resolveSystemdServiceName } from "../../daemon/systemd-service-files.js";
import { sha256Hex } from "../../infra/crypto-digest.js";
import { readActiveGatewayLockIdentity } from "../../infra/gateway-lock.js";
import { probePortUsage } from "../../infra/ports-probe.js";
import { isCurrentManagedServiceUpdateHandoffProcess } from "../../infra/update-managed-service-handoff.js";
import { getUpdateRun, recordUpdateRunPhase } from "../../infra/update-run-ledger.js";
import { defaultRuntime } from "../../runtime.js";
import { UpdatePreMutationError, type UpdateCommandOptions } from "./shared.js";
import { gatewayMaintenanceBlockMessage } from "./update-command-handoff.js";
import { UpdateCommandRecoveryPendingError } from "./update-command-recovery.js";
import type { PreManagedServiceStop } from "./update-command-service-context-types.js";
import {
  assertGatewayServiceAdmissionUnchanged,
  assertGatewayServiceManagementAllowedForUpdate,
  gatewayServiceCommandUsesRoot,
  GatewayServiceUpdateOwnershipError,
  resolveGatewayServiceManagementBlockMessageForUpdate,
  resolveManagedServiceNodeRunner,
  resolveUpdatedGatewayRestartPort,
  type ManagedGatewayUpdateVerdict,
} from "./update-command-service-plan.js";
import {
  createWindowsTaskAutoStartRecovery,
  UpdateCommandAbort,
  type WindowsTaskAutoStartRecovery,
} from "./update-command-windows-task.js";

export type { PreManagedServiceStop } from "./update-command-service-context-types.js";
export { UpdateCommandAbort } from "./update-command-windows-task.js";

const GATEWAY_SERVICE_INSPECTION_BLOCK_MESSAGE =
  "Gateway service inspection is unavailable. Refusing to mutate code because managed service ownership cannot be verified. Run `openclaw gateway status --deep` and retry when service access is restored.";
const JSON_MODE_SERVICE_STDOUT = new Writable({
  write(_chunk, _encoding, callback) {
    callback();
  },
});

function serviceInspectionBlockMessage(state: GatewayServiceState): string {
  const timeoutMs = state.runtime?.inspectionFailure?.timeoutMs;
  return timeoutMs === undefined
    ? GATEWAY_SERVICE_INSPECTION_BLOCK_MESSAGE
    : `Scheduled Task probe timed out after ${timeoutMs} ms (ETIMEDOUT). ${GATEWAY_SERVICE_INSPECTION_BLOCK_MESSAGE}`;
}

export function resolvePreparedGatewayUpdatePolicy(
  stopState: PreManagedServiceStop | undefined,
  shouldRestart: boolean,
) {
  const verdict = stopState?.serviceUpdateVerdict;
  // Root ownership permits activation; rewriting also requires definition authority.
  return {
    allowGatewayServiceRepair: verdict?.kind === "owned" && verdict.refreshDefinition,
    allowGatewayActivation:
      shouldRestart && stopState?.stopped === true && verdict?.kind === "owned",
  };
}

function observedSystemdManagerUid(state: GatewayServiceState): number | undefined {
  const uid = state.runtime?.systemd?.managerUid;
  return typeof uid === "number" && Number.isInteger(uid) && uid >= 0 && uid < 0xffffffff
    ? uid
    : undefined;
}

async function inspectManagedGatewayServiceBeforeUpdate(params: {
  root: string;
  state: GatewayServiceState;
}): Promise<ManagedGatewayUpdateVerdict> {
  const { state, root } = params;
  const { command } = state;
  const unavailable = (): ManagedGatewayUpdateVerdict => ({
    kind: "unavailable",
    message: serviceInspectionBlockMessage(state),
  });
  if (!command) {
    return !state.installed &&
      state.loadState.status === "not-loaded" &&
      !state.running &&
      state.runtime?.missingUnit &&
      (await readActiveGatewayLockIdentity({ env: state.env, requireInspection: true }).then(
        (identity) => !identity,
        () => false,
      )) &&
      (await probePortUsage(await resolveUpdatedGatewayRestartPort({ serviceEnv: state.env }))) ===
        "free"
      ? { kind: "absent" }
      : unavailable();
  }
  // Lifecycle authority follows the effective launcher, not the writable base
  // that a drop-in may replace with a different installation.
  const ownsRoot = await gatewayServiceCommandUsesRoot({ root, command });
  if (ownsRoot === false) {
    return { kind: "foreign" };
  }
  if (
    state.loadState.status === "unknown" ||
    (state.runtime?.status !== "running" && state.runtime?.status !== "stopped") ||
    (process.platform === "linux" && observedSystemdManagerUid(state) === undefined)
  ) {
    return unavailable();
  }
  const serialized = stableStringify(command);
  if (Buffer.byteLength(serialized) > 4 * 1024 * 1024) {
    return unavailable();
  }
  const fingerprint = sha256Hex(serialized);
  return ownsRoot
    ? {
        kind: "owned",
        root,
        fingerprint,
        refreshDefinition: (state.definitionMutationCapability?.kind ?? "writable") === "writable",
      }
    : { kind: "unresolved", root, fingerprint };
}

function matchesStoppedService(
  before: Pick<PreManagedServiceStop, "serviceEnv" | "serviceUpdateVerdict" | "serviceManagerUid">,
  state: GatewayServiceState,
  inspection: ManagedGatewayUpdateVerdict,
): boolean {
  const verdict = before.serviceUpdateVerdict;
  const refreshDefinition = verdict?.kind === "owned" && verdict.refreshDefinition;
  const resolveName =
    process.platform === "darwin"
      ? resolveLaunchAgentLabel
      : process.platform === "win32"
        ? resolveTaskName
        : resolveSystemdServiceName;
  // Explicit default metadata selects the same manager; protected command hashes
  // still pin the effective launcher and its environment through normalization.
  // Stable 2026.9.2/2026.9.3 handoffs omit the UID; compare it when recorded.
  return Boolean(
    before.serviceEnv &&
    state.command &&
    verdict &&
    "fingerprint" in verdict &&
    resolveGatewayProfileSuffix(before.serviceEnv.OPENCLAW_PROFILE) ===
      resolveGatewayProfileSuffix(state.env.OPENCLAW_PROFILE) &&
    resolveName(before.serviceEnv) === resolveName(state.env) &&
    (process.platform !== "linux" ||
      before.serviceManagerUid === undefined ||
      before.serviceManagerUid === observedSystemdManagerUid(state)) &&
    (refreshDefinition ||
      ("fingerprint" in inspection && inspection.fingerprint === verdict.fingerprint)),
  );
}

export async function revalidateManagedGatewayServiceAfterUpdate(params: {
  state: GatewayServiceState;
  root: string;
  preManagedServiceStop?: Pick<
    PreManagedServiceStop,
    "serviceEnv" | "serviceUpdateVerdict" | "serviceManagerUid"
  >;
  allowInstallRootChange?: boolean;
}): Promise<ManagedGatewayUpdateVerdict> {
  const before = params.preManagedServiceStop;
  const verdict = before?.serviceUpdateVerdict;
  assertGatewayServiceManagementAllowedForUpdate(params.state.env);
  const inspection = await inspectManagedGatewayServiceBeforeUpdate(params);
  if (
    params.allowInstallRootChange &&
    before &&
    verdict?.kind === "owned" &&
    verdict.refreshDefinition &&
    (inspection.kind === "foreign" || inspection.kind === "unresolved") &&
    (params.state.definitionMutationCapability?.kind ?? "writable") === "writable"
  ) {
    const retained = await inspectManagedGatewayServiceBeforeUpdate({
      state: params.state,
      root: verdict.root,
    });
    // A verified core install can replace its root before rewriting the launcher.
    // Pin the original command even when pnpm has removed its old package directory.
    if (
      matchesStoppedService(
        { ...before, serviceUpdateVerdict: { ...verdict, refreshDefinition: false } },
        params.state,
        retained,
      )
    ) {
      return { ...verdict, requiresInstallRootRefresh: true };
    }
  }
  if (
    before &&
    verdict &&
    (verdict.kind === "owned" || verdict.kind === "unresolved") &&
    (inspection.kind !== verdict.kind || !matchesStoppedService(before, params.state, inspection))
  ) {
    throw new GatewayServiceUpdateOwnershipError(
      inspection.kind === "unavailable" &&
        params.state.runtime?.inspectionFailure?.timeoutMs !== undefined
        ? inspection.message
        : "Gateway service ownership or manager identity changed; inspect it before restarting manually.",
      undefined,
    );
  }
  return inspection.kind === "owned" && verdict?.kind === "owned" && !verdict.refreshDefinition
    ? { ...inspection, refreshDefinition: false }
    : inspection;
}

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
  phase?: "inspect" | "prepare";
  handoffFromGateway?: (state: GatewayServiceState) => Promise<boolean>;
  expectedService?: Pick<
    PreManagedServiceStop,
    "serviceEnv" | "serviceUpdateVerdict" | "serviceManagerUid"
  >;
  allowInstallRootChange?: boolean;
  onStopped?: (state: PreManagedServiceStop) => void;
  timeoutMs?: number;
};

export async function maybeStopManagedServiceBeforeMutableUpdate(
  params: ManagedServiceStopParams,
): Promise<PreManagedServiceStop> {
  if (params.recovery) {
    throw new UpdateCommandRecoveryPendingError(
      "Full-state checkpoint recovery is deferred; retained state was left unchanged.",
    );
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
    assertNative?.();
    assertExecutor();
  };
  // A Linux systemd scope changes cgroup ownership, not Unix ancestry. Reprove
  // the exact current handoff lease at each boundary that can stop its ancestor.
  const resolveAncestryBlock = async (state: GatewayServiceState) => {
    const blockMessage = gatewayMaintenanceBlockMessage(state, params.root);
    if (
      !blockMessage ||
      ((params.phase === "inspect" || process.platform === "linux") &&
        (await isCurrentManagedServiceUpdateHandoffProcess({
          root: params.root,
          runId: params.updateRun?.runId,
        })))
    ) {
      return undefined;
    }
    return blockMessage;
  };
  assertCurrent();
  const uninspected = { stopped: false, inspected: false, runtimeInspected: false, running: false };
  const markInspectionUnavailable = (
    base: PreManagedServiceStop,
    message: string,
  ): PreManagedServiceStop => ({
    ...base,
    serviceMutationAllowed: false,
    serviceUpdateVerdict: { kind: "unavailable", message },
    blockMessage: message,
  });
  const serviceMutationSkipMessage = resolveGatewayServiceManagementBlockMessageForUpdate(
    process.env,
  );
  if (serviceMutationSkipMessage) {
    return { ...uninspected, serviceMutationAllowed: false, serviceMutationSkipMessage };
  }
  let service: ReturnType<typeof resolveGatewayService>;
  let serviceState: GatewayServiceState;
  try {
    service = resolveGatewayService();
    serviceState = await readGatewayServiceState(service, {
      env: process.env,
      requireEffective: true,
      requireLoadedCommand: true,
      validateEnvBeforeStatusRead: assertGatewayServiceManagementAllowedForUpdate,
      timeoutMs: params.timeoutMs,
    });
    if (
      process.platform === "win32" &&
      serviceState.runtime?.inspectionFailure?.timeoutMs !== undefined
    ) {
      // Re-read the definition too: a timed-out snapshot cannot grant service ownership.
      serviceState = await readGatewayServiceState(service, {
        env: process.env,
        requireEffective: true,
        validateEnvBeforeStatusRead: assertGatewayServiceManagementAllowedForUpdate,
        timeoutMs: params.timeoutMs,
      });
    }
  } catch (err) {
    assertCurrent();
    if (err instanceof GatewayServiceUpdateOwnershipError) {
      return { ...uninspected, serviceMutationAllowed: false, blockMessage: err.message };
    }
    return markInspectionUnavailable(uninspected, GATEWAY_SERVICE_INSPECTION_BLOCK_MESSAGE);
  }
  assertCurrent();
  const serviceUpdateVerdict = await revalidateManagedGatewayServiceAfterUpdate({
    root: params.root,
    state: serviceState,
    preManagedServiceStop: params.expectedService,
    allowInstallRootChange: params.allowInstallRootChange,
  });
  assertCurrent();
  if (params.phase) {
    // Admission pins the definition; post-update ownership permits authorized refresh.
    assertGatewayServiceAdmissionUnchanged(params.expectedService, serviceUpdateVerdict);
  }
  const inspected = {
    stopped: false,
    inspected: true,
    runtimeInspected: ["running", "stopped"].includes(serviceState.runtime?.status ?? ""),
    running: serviceState.running,
    // Enabled systemd units may be manually stopped; loaded LaunchAgents can
    // respawn. Windows needs the live numeric task state, not its last result.
    offline:
      serviceState.runtime?.status === "stopped" &&
      (process.platform === "darwin"
        ? serviceState.loadState.status === "not-loaded" ||
          (serviceState.loadState.status === "loaded" &&
            (await service
              .isEnabled?.({ env: serviceState.env, timeoutMs: params.timeoutMs })
              .catch(() => undefined)) === false)
        : process.platform === "win32"
          ? isScheduledTaskDefinitelyNotRunning(resolveTaskName(serviceState.env)) ||
            (await readWindowsStartupFallbackRuntimeForUpdate(serviceState.env).catch(() => null))
              ?.status === "stopped"
          : process.platform === "linux"),
    serviceEnv: serviceState.env,
    serviceDefinitionEnv:
      resolveManagedGatewayServiceCommand(serviceState.command)?.environment ?? {},
    serviceNodeRunner: resolveManagedServiceNodeRunner(serviceState.command),
    ...(process.platform === "linux"
      ? { serviceManagerUid: observedSystemdManagerUid(serviceState) }
      : {}),
    serviceUpdateVerdict,
  };
  assertCurrent();
  if (serviceUpdateVerdict.kind === "unavailable") {
    return markInspectionUnavailable(inspected, serviceUpdateVerdict.message);
  }
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
      assertCurrent: updateRun
        ? () => {
            // Recovery outlives this preparation callback. Its later task
            // operations acquire their own native lock, but retain this executor.
            assertExecutor();
            if (getUpdateRun(updateRun.runId, { env: updateRun.env })?.status !== "running") {
              throw new Error("Update run no longer owns Windows task activation.");
            }
          }
        : undefined,
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
  if (!params.shouldRestart || (!serviceState.running && !supervisorMayRespawn)) {
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
    const currentState = await readGatewayServiceState(service, {
      env: serviceState.env,
      requireEffective: true,
      requireLoadedCommand: true,
      validateEnvBeforeStatusRead: assertGatewayServiceManagementAllowedForUpdate,
      timeoutMs: params.timeoutMs,
    });
    const currentVerdict = await revalidateManagedGatewayServiceAfterUpdate({
      state: currentState,
      root: params.root,
      preManagedServiceStop: inspected,
      allowInstallRootChange: params.allowInstallRootChange,
    });
    assertGatewayServiceAdmissionUnchanged(inspected, currentVerdict);
    assertCurrent();
    const currentBlockMessage = await resolveAncestryBlock(currentState);
    if (currentBlockMessage) {
      throw new UpdatePreMutationError("managed-service-preflight", currentBlockMessage);
    }
    stoppedAtMs = Date.now();
    if (params.updateRun) {
      recordUpdateRunPhase(params.updateRun.runId, "activating", undefined, {
        env: params.updateRun.env,
      });
    }
    await service.stop({
      env: currentState.env,
      stdout: params.jsonMode ? JSON_MODE_SERVICE_STDOUT : process.stdout,
      assertCurrent,
      // Native stop may unload the service before a later port check fails.
      onMutation: () => params.onStopped?.({ ...inspected, stopped: true, stoppedAtMs }),
    });
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
    serviceDefinitionEnv:
      resolveManagedGatewayServiceCommand(serviceState.command)?.environment ?? {},
    ...(windowsTaskAutoStartRecovery ? { windowsTaskAutoStartRecovery } : {}),
  };
}

export function shouldBlockMutableUpdateFromGatewayServiceEnv(params: {
  preManagedServiceStop: PreManagedServiceStop | undefined;
}): boolean {
  const stopState = params.preManagedServiceStop;
  return (
    isGatewayServiceEnv(process.env) &&
    (!stopState?.inspected ||
      (!stopState.stopped &&
        (!stopState.runtimeInspected ||
          (stopState.running &&
            (!stopState.blockMessage || stopState.serviceUpdateVerdict?.kind === "unavailable")))))
  );
}

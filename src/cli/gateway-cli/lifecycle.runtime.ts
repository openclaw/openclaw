// Lazy lifecycle runtime export hub used by gateway run-loop restart paths.
export {
  abortEmbeddedAgentRun,
  getActiveEmbeddedRunCount,
  listActiveEmbeddedRunSessionIds,
  listActiveEmbeddedRunSessionKeys,
  waitForActiveEmbeddedRuns,
} from "../../agents/embedded-agent-runner/runs.js";
export { markRestartAbortedMainSessions } from "../../agents/main-session-restart-recovery.js";
export { getRuntimeConfig } from "../../config/config.js";
export {
  respawnGatewayProcessForUpdate,
  restartGatewayProcessWithFreshPid,
} from "../../infra/process-respawn.js";
export {
  resolveGatewayRestartDeferralTimeoutMs,
  consumeGatewayRestartIntentPayloadSync,
  consumeGatewaySigusr1RestartIntent,
  consumeGatewayRestartIntentSync,
  consumeGatewaySigusr1RestartAuthorization,
  isGatewaySigusr1RestartExternallyAllowed,
  markGatewaySigusr1RestartHandled,
  peekGatewaySigusr1RestartReason,
  resetGatewayRestartStateForInProcessRestart,
  scheduleGatewaySigusr1Restart,
} from "../../infra/restart.js";
export { writeGatewayRestartHandoffSync } from "../../infra/restart-handoff.js";
export { rotateAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
export { markUpdateRestartSentinelFailure } from "../../infra/restart-sentinel.js";
export { detectRespawnSupervisor } from "../../infra/supervisor-markers.js";
export { writeDiagnosticStabilityBundleForFailureSync } from "../../logging/diagnostic-stability-bundle.js";
export {
  advanceCronActiveJobGeneration,
  resetCronActiveJobs,
  waitForActiveCronJobs,
} from "../../cron/active-jobs.js";
export {
  abortActiveCronTaskRuns,
  retireActiveCronTaskRunTracking,
  waitForActiveCronTaskRuns,
} from "../../tasks/cron-task-cancel.js";
export {
  getActiveTaskCount,
  markGatewayDraining,
  resetAllLanes,
  waitForActiveTasks,
} from "../../process/command-queue.js";
export { getInspectableActiveTaskRestartBlockers } from "../../tasks/task-registry.maintenance.js";
export { reloadTaskRegistryFromStore } from "../../tasks/runtime-internal.js";
export { abortPendingChannelReloads } from "../../gateway/server-reload-handlers.js";

type DurableStartupModule = typeof import("../../durable/startup.js");

let durableStartupModulePromise: Promise<DurableStartupModule> | undefined;

function loadDurableStartupModule(): Promise<DurableStartupModule> {
  durableStartupModulePromise ??= import("../../durable/startup.js");
  return durableStartupModulePromise;
}

export async function maybeRecordDurableGatewayStartup(
  params: Parameters<DurableStartupModule["maybeRecordDurableGatewayStartup"]>[0],
): Promise<void> {
  const durableStartup = await loadDurableStartupModule();
  await durableStartup.maybeRecordDurableGatewayStartup(params);
}

export async function startDurableGatewayRecoveryWorker(
  params: Parameters<DurableStartupModule["startDurableGatewayRecoveryWorker"]>[0],
): Promise<() => void> {
  const durableStartup = await loadDurableStartupModule();
  return await durableStartup.startDurableGatewayRecoveryWorker(params);
}

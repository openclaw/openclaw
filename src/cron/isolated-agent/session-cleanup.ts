import { retireSessionMcpRuntime } from "../../agents/agent-bundle-mcp-tools.js";
import { stopSessionExecProcesses } from "../../agents/bash-process-control.js";
import { isSessionLifecycleChangedGatewayError } from "../../config/sessions/lifecycle.js";
import { releaseAgentRunContext } from "../../infra/agent-run-registry.js";
import { logWarn } from "../../logger.js";
import { isCronSessionKey } from "../../routing/session-key.js";
import { isCronRunSessionKey } from "../../sessions/session-key-utils.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import type { CronJob } from "../types.js";
import type { MutableCronSession } from "./run-session-state.js";

const gatewayCallRuntimeLoader = createLazyImportLoader(
  () => import("../../agents/tools/in-process-gateway.js"),
);

export type CronRunSessionCleanupOutcome =
  | "not-requested"
  | "deleted"
  | "retired"
  | "survived"
  | "changed";

export async function deleteCronSessionViaGateway(params: {
  agentSessionKey: string;
  sessionId: string;
  lifecycleRevision?: string;
  sessionUpdatedAt?: number;
}): Promise<boolean> {
  const { bindAgentToolGatewayRequest } = await gatewayCallRuntimeLoader.load();
  const callGateway = bindAgentToolGatewayRequest({ hostedOnly: true });
  const result = await callGateway<{ deleted?: boolean }>({
    method: "sessions.delete",
    params: {
      key: params.agentSessionKey,
      deleteTranscript: true,
      emitLifecycleHooks: false,
      expectedSessionId: params.sessionId,
      expectedLifecycleRevision: params.lifecycleRevision,
      expectedSessionUpdatedAt: params.sessionUpdatedAt,
    },
    // History archival can outlive a response deadline. Keep the guarded lifecycle
    // request and its authority alive until deletion settles.
    timeoutMs: null,
  });
  return result.deleted === true;
}

export async function cleanupCronRunSessionAfterRun(params: {
  job: Pick<CronJob, "deleteAfterRun" | "sessionTarget">;
  agentSessionKey: string;
  sessionId: string;
  lifecycleRevision: string;
  sessionUpdatedAt: number;
  beforeDelete?: () => void;
  reason: string;
}): Promise<CronRunSessionCleanupOutcome> {
  if (!shouldDeleteCronRunSessionAfterRun(params)) {
    return "not-requested";
  }
  params.beforeDelete?.();
  try {
    return (await deleteCronSessionViaGateway(params)) ? "deleted" : "changed";
  } catch (error) {
    if (isSessionLifecycleChangedGatewayError(error)) {
      return "changed";
    }
    if (params.job.sessionTarget === "isolated") {
      await retireSessionMcpRuntime({
        sessionId: params.sessionId,
        reason: params.reason,
      });
      return "retired";
    }
    // Persistent custom targets survive transport failures. The caller may
    // restore delivery state with the same lifecycle revision as an atomic guard.
    return "survived";
  }
}

function shouldDeleteCronRunSessionAfterRun(params: {
  job: Pick<CronJob, "deleteAfterRun" | "sessionTarget">;
  agentSessionKey: string;
}): boolean {
  return params.job.deleteAfterRun === true && isCronSessionKey(params.agentSessionKey);
}

/**
 * An isolated run session (`:run:`) takes no turn after its run ends, so nothing would manage
 * its services or leftover processes: stop them, as a hidden subagent's task end does. A yield
 * on this run's commands resumes inside the run (`executeCronRun`), so it has settled by now.
 */
async function stopEndedCronRunProcesses(runSessionKey: string, sessionId: string) {
  if (!isCronRunSessionKey(runSessionKey)) {
    return;
  }
  await stopSessionExecProcesses([runSessionKey, sessionId], () => {}).catch((error: unknown) =>
    logWarn(`[cron] Run session processes did not stop: ${String(error)}`),
  );
}

// Release the full session snapshot after persistence and delivery to avoid retaining skill prompts.
export async function disposeCronRunContext(params: {
  runId: string;
  sessionId: string;
  runSessionKey: string;
  cronSession: MutableCronSession;
  ownsSessionRuntime: boolean;
  runContextOwnerToken?: string;
}): Promise<void> {
  releaseAgentRunContext(params.runId, params.runContextOwnerToken);
  await stopEndedCronRunProcesses(params.runSessionKey, params.sessionId);
  if (params.ownsSessionRuntime) {
    await retireSessionMcpRuntime({
      sessionId: params.sessionId,
      reason: "isolated-cron-dispose",
      onError: (error, sid) => {
        logWarn(
          `[cron] Failed to retire MCP runtime during isolated cron dispose ${sid}: ${String(error)}`,
        );
      },
    }).catch(() => {});
  }
  params.cronSession.store = {};
}

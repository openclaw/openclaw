import { retireSessionMcpRuntime } from "../../agents/agent-bundle-mcp-tools.js";
import { isSessionLifecycleChangedGatewayError } from "../../config/sessions/lifecycle.js";
import { isCronSessionKey, parseAgentSessionKey } from "../../routing/session-key.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import type { CronJob } from "../types.js";
import { resolveCronAgentSessionKey } from "./session-key.js";

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
  job: Pick<CronJob, "id" | "deleteAfterRun" | "sessionTarget">;
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
  job: Pick<CronJob, "id" | "deleteAfterRun" | "sessionTarget">;
  agentSessionKey: string;
}): boolean {
  if (params.job.deleteAfterRun !== true) {
    return false;
  }
  if (params.job.sessionTarget !== "isolated") {
    return isCronSessionKey(params.agentSessionKey);
  }
  // An isolated run owns only its cron:<jobId> session. A hook may name an existing
  // cron: session, such as a stored automation's, which the run reuses but must keep.
  const agentId = parseAgentSessionKey(params.agentSessionKey)?.agentId;
  return (
    agentId !== undefined &&
    params.agentSessionKey ===
      resolveCronAgentSessionKey({ sessionKey: `cron:${params.job.id}`, agentId })
  );
}

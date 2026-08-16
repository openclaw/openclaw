import { readSessionChangedError } from "../../../packages/gateway-protocol/src/index.js";
import { retireSessionMcpRuntime } from "../../agents/agent-bundle-mcp-tools.js";
import { isCronSessionKey } from "../../routing/session-key.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import type { CronJob } from "../types.js";

const gatewayCallRuntimeLoader = createLazyImportLoader(
  () => import("../../gateway/call.runtime.js"),
);

export type CronRunSessionCleanupOutcome =
  | "not-requested"
  | "deleted"
  | "retired"
  | "survived"
  | "changed";

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
    const { callGateway } = await gatewayCallRuntimeLoader.load();
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
      timeoutMs: 10_000,
    });
    return result.deleted === true ? "deleted" : "changed";
  } catch (error) {
    if (readSessionChangedError(error)) {
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

import { resolveAgentMainSessionKey } from "../config/sessions/main-session.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import type { ReplyOperationObservation } from "../sessions/reply-operation-state.js";
import { activeSessionOperations } from "../sessions/session-controller.state.js";
import { hasActiveCronJobsForAgent, isCronReplyOperationWaitingForIdle } from "./active-jobs.js";
import { resolveCronDeliverySessionKey } from "./session-target.js";
import type { CronJob } from "./types.js";

/** Recovery and session queues belong to ordinary reply admission; this is its ambient idle policy. */
export function isCronExecutionIdle(
  cfg: OpenClawConfig,
  job: CronJob,
  agentId: string,
  _ownSessionKey?: string,
  ownReplyOperation?: ReplyOperationObservation,
): boolean {
  if (hasActiveCronJobsForAgent(agentId, job.id, { excludeIdleWaiters: true })) {
    return false;
  }
  const sessionKey =
    (job.sessionTarget === "main" ? undefined : resolveCronDeliverySessionKey(job)) ??
    resolveAgentMainSessionKey({ cfg, agentId });
  return ![...activeSessionOperations()].some((operation) => {
    const key = operation.key;
    if (key !== sessionKey && parseAgentSessionKey(key)?.agentId !== agentId) {
      return false;
    }
    return !(
      (operation === ownReplyOperation && !operation.abortSignal.aborted && !operation.result) ||
      isCronReplyOperationWaitingForIdle(operation)
    );
  });
}

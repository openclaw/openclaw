import { listActiveEmbeddedRunSessionKeys } from "../agents/embedded-agent-runner/active-run-projections.js";
import {
  listActiveReplyRunSessionKeys,
  replyRunRegistry,
  type ReplyOperation,
} from "../auto-reply/reply/reply-run-registry.js";
import { resolveAgentMainSessionKey } from "../config/sessions/main-session.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { hasActiveCronJobsForAgent, isCronReplyOperationWaitingForIdle } from "./active-jobs.js";
import { resolveCronDeliverySessionKey } from "./session-target.js";
import type { CronJob } from "./types.js";

/** Recovery and session queues belong to ordinary reply admission; this is its ambient idle policy. */
export function isCronExecutionIdle(
  cfg: OpenClawConfig,
  job: CronJob,
  agentId: string,
  ownSessionKey?: string,
  ownReplyOperation?: ReplyOperation,
): boolean {
  if (hasActiveCronJobsForAgent(agentId, job.id, { excludeIdleWaiters: true })) {
    return false;
  }
  const sessionKey =
    (job.sessionTarget === "main" ? undefined : resolveCronDeliverySessionKey(job)) ??
    resolveAgentMainSessionKey({ cfg, agentId });
  if (
    listActiveEmbeddedRunSessionKeys({ includeReplyRuns: false }).some(
      (key) =>
        (ownReplyOperation !== undefined || key !== ownSessionKey) &&
        (key === sessionKey || parseAgentSessionKey(key)?.agentId === agentId),
    )
  ) {
    return false;
  }
  return !listActiveReplyRunSessionKeys().some((key) => {
    if (key !== sessionKey && parseAgentSessionKey(key)?.agentId !== agentId) {
      return false;
    }
    const operation = replyRunRegistry.get(key);
    if (!operation) {
      return false;
    }
    return !(
      (operation === ownReplyOperation && !operation.abortSignal.aborted && !operation.result) ||
      isCronReplyOperationWaitingForIdle(operation)
    );
  });
}

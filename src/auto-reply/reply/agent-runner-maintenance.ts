import { OPENCLAW_AGENT_RUNTIME_ID } from "../../agents/agent-runtime-id.js";
import {
  createSessionMaintenanceFollowup,
  scheduleSessionMaintenance,
} from "../../agents/session-maintenance/run.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { runAgentRequestedCompactionIfNeeded } from "./agent-runner-memory.js";
import type { AccountedAgentTurn } from "./agent-runner-result-accounting.js";
import type { FinalizeReplyAgentRunInput } from "./agent-runner-result.types.js";

/** The descriptor contains no foreground authority; actual delivery settlement gates its new owner. */
export function scheduleReplySessionMaintenance(params: {
  context: FinalizeReplyAgentRunInput;
  accounting: AccountedAgentTurn;
  sessionEntry?: SessionEntry;
}): void {
  const { context, accounting, sessionEntry } = params;
  const { replyOperation, followupRun, cfg, sessionKey, storePath } = context;
  const meta = accounting.runResult.meta;
  const auth = context.execution.maintenanceAuthProfile;
  if (
    !sessionEntry ||
    !sessionKey ||
    !storePath ||
    !accounting.providerUsed ||
    !replyOperation.ownerSettlement ||
    !replyOperation.lifecycleGeneration ||
    context.isHeartbeat ||
    accounting.preserveUserFacingSessionState ||
    context.execution.status !== "ok" ||
    accounting.fallbackExhausted ||
    accounting.autoCompactionCount > 0 ||
    meta?.aborted ||
    meta?.yielded ||
    meta?.error ||
    meta?.agentMeta?.agentHarnessId !== OPENCLAW_AGENT_RUNTIME_ID ||
    auth === undefined ||
    cfg.agents?.defaults?.compaction?.enabled === false
  ) {
    return;
  }
  const prepared = {
    cfg,
    sessionKey,
    storePath,
    timeoutMs: followupRun.run.timeoutMs,
    runtimePolicySessionKey: context.runtimePolicySessionKey,
  };
  scheduleSessionMaintenance(
    {
      prepared,
      followupRun: createSessionMaintenanceFollowup({
        run: followupRun.run,
        sessionEntry,
        cfg,
        sessionKey,
        runtimePolicySessionKey:
          context.runtimePolicySessionKey ?? followupRun.run.runtimePolicySessionKey,
        provider: accounting.providerUsed,
        model: accounting.modelUsed,
        auth,
      }),
      sessionId: sessionEntry.sessionId,
      lifecycleRevision: sessionEntry.lifecycleRevision,
      lifecycleGeneration: replyOperation.lifecycleGeneration,
      startedAt: replyOperation.startedAtMs,
      agentHarnessId: meta.agentMeta.agentHarnessId,
      compactionRequestBudget: context.execution.compactionRequestBudget,
    },
    replyOperation.ownerSettlement.then(
      () => replyOperation.result?.kind === "completed" && !replyOperation.abortSignal.aborted,
    ),
  );
}

/**
 * Runs an agent-requested compaction (session_compact tool) after the reply's
 * delivery settlement: the response is delivered first, and the turn's
 * deferred lifecycle has already released the embedded active-run handle by
 * then, so the manual compaction pipeline cannot reject with `active_run`.
 */
export function scheduleReplyRequestedTurnCompaction(params: {
  context: FinalizeReplyAgentRunInput;
}): void {
  const { context } = params;
  const request = context.execution.agentCompactionRequest;
  const { replyOperation } = context;
  if (!request || !replyOperation.ownerSettlement) {
    return;
  }
  void replyOperation.ownerSettlement
    .then(async () => {
      if (replyOperation.abortSignal.aborted) {
        return;
      }
      await runAgentRequestedCompactionIfNeeded({
        cfg: context.cfg,
        followupRun: context.followupRun,
        request,
        sessionEntry: context.activeSessionEntry,
        sessionStore: context.activeSessionStore,
        sessionKey: context.sessionKey,
        runtimePolicySessionKey: context.runtimePolicySessionKey,
        storePath: context.storePath,
        isHeartbeat: context.isHeartbeat,
        abortSignal: context.opts?.abortSignal,
      });
    })
    .catch(() => {
      // The helper swallows its own failures; this only guards the settlement
      // chain itself from surfacing as an unhandled rejection.
    });
}

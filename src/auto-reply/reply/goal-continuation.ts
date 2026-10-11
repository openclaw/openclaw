import type { EmbeddedAgentRunResult } from "../../agents/embedded-agent-runner/types.js";
import { accountSessionGoalUsage } from "../../config/sessions/goals-transitions.js";
import { readSessionEntryReadOnlyInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import type { SessionEntryCohortReader } from "../../config/sessions/session-entry-read-runtime.types.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { formatSystemTurnPrompt } from "../../sessions/system-turn-prompt.js";
import { SkillLibraryError } from "../../skills/skill-library-error.js";
import { enqueueFollowupRun, getFollowupQueueDepth } from "./queue/enqueue.js";
import { isFollowupRunAborted, type FollowupRun, type QueueSettings } from "./queue/types.js";
import { runAfterReplyOperationClear, type ReplyOperation } from "./reply-run-registry.js";

export type GoalContinuation = Pick<SessionEntry, "sessionId" | "lifecycleRevision"> & {
  goalId: string;
};

export function isGoalContinuationCurrent(
  continuation: GoalContinuation,
  entry: SessionEntry | undefined,
): boolean {
  const goal = entry && accountSessionGoalUsage(entry, Date.now());
  return Boolean(
    entry &&
    entry.sessionId === continuation.sessionId &&
    entry.lifecycleRevision === continuation.lifecycleRevision &&
    goal?.id === continuation.goalId &&
    goal.status === "active" &&
    !entry.abortedLastRun &&
    (entry.agentHarnessId === undefined || entry.agentHarnessId === "openclaw"),
  );
}

function isGoalContinuationOutcome(result: EmbeddedAgentRunResult): boolean {
  const meta = result.meta;
  return (
    (meta.stopReason === "end_turn" || meta.stopReason === "stop") &&
    !meta.aborted &&
    !meta.error &&
    !meta.timeoutPhase &&
    !meta.yielded &&
    !meta.continuationPending &&
    !meta.pendingToolCalls?.length &&
    !result.acceptedSessionSpawns?.length &&
    !result.didSendDeterministicApprovalPrompt &&
    !result.payloads?.some((payload) => payload.isError)
  );
}

/** Queue custody, not a second scheduler, owns every automatic Goal turn. */
export async function enqueueGoalContinuation(params: {
  base: FollowupRun;
  result: EmbeddedAgentRunResult;
  initialGoalId?: string;
  expectedSession: Pick<SessionEntry, "sessionId" | "lifecycleRevision">;
  sessionKey: string;
  storePath: string;
  reader?: SessionEntryCohortReader;
  queueKey: string;
  settings: QueueSettings;
  sourceRunId: string;
  operation: ReplyOperation;
  runFollowup: (run: FollowupRun) => Promise<void>;
}): Promise<boolean> {
  const eligible = () =>
    !params.operation.abortSignal.aborted &&
    params.operation.result?.kind !== "failed" &&
    params.operation.result?.kind !== "aborted" &&
    !isFollowupRunAborted(params.base) &&
    getFollowupQueueDepth(params.queueKey) === 0;
  if (!isGoalContinuationOutcome(params.result) || !eligible()) {
    return false;
  }
  const { listUnsettledRequesterChildren } =
    await import("../../agents/subagents/registry/subagent-registry.js");
  const children = await listUnsettledRequesterChildren({
    requesterSessionKey: params.sessionKey,
    requesterAgentId: params.base.run.agentId,
  });
  if (children.length > 0 || !eligible()) {
    return false;
  }
  const entry = await readSessionEntryReadOnlyInWorker(
    { storePath: params.storePath, sessionKey: params.sessionKey },
    undefined,
    params.reader,
  );
  params.base.operatorAuthority?.assertCurrent();
  if (!eligible() || !entry?.goal) {
    return false;
  }
  const continuation: GoalContinuation = {
    ...params.expectedSession,
    goalId: params.initialGoalId ?? entry.goal.id,
  };
  if (!isGoalContinuationCurrent(continuation, entry)) {
    return false;
  }
  const source = params.base.queuedFollowupReplyDisposition;
  if (source?.kind === "drop") {
    return false;
  }
  const base = params.base;
  const cancellation = new AbortController();
  const nudge: FollowupRun = {
    ...base,
    goalContinuation: continuation,
    prompt: formatSystemTurnPrompt(
      "Advance the active goal; keep it active until fully achieved. Use the current goal context, and verify the entire objective before marking it complete.",
    ),
    summaryLine: "goal-continuation",
    messageId: ["goal", continuation.sessionId, continuation.goalId, params.sourceRunId].join(":"),
    abortSignal: base.abortSignal
      ? AbortSignal.any([base.abortSignal, cancellation.signal])
      : cancellation.signal,
    enqueuedAt: Date.now(),
    disableCollectBatching: true,
    transcriptPrompt: undefined,
    userTurnTranscriptRecorder: undefined,
    currentInboundContext: undefined,
    images: undefined,
    imageOrder: undefined,
    media: undefined,
    turnAdoptionLifecycle: undefined,
    replyOperationRunStates: undefined,
    onQueueDisposition: undefined,
    steerPending: undefined,
    strandedReplyRetry: undefined,
    stalledTurnRecovery: undefined,
    queuedFollowupReplyDisposition:
      source?.kind === "deliver"
        ? { kind: "deliver", deliver: source.deliver.createSourceRetry?.() ?? source.deliver }
        : source,
    run: {
      ...base.run,
      inputProvenance: { kind: "internal_system", sourceTool: "session_goal_continue" },
      suppressNextUserMessagePersistence: true,
      skillLibraryAuthoring: base.run.skillLibraryAuthoring && {
        target: "personal",
        defaultTarget: "personal",
        multipleProfiles: base.run.skillLibraryAuthoring.multipleProfiles,
        bind: () => {},
        invoke: async () => {
          throw new SkillLibraryError(
            "AUTHORITY_EXPIRED",
            "Skill authoring requires a fresh user request after the previous turn settled.",
          );
        },
      },
    },
  };
  const enqueued = enqueueFollowupRun(
    params.queueKey,
    nudge,
    params.settings,
    "message-id",
    params.runFollowup,
    false,
  );
  if (enqueued) {
    // Model completion precedes source delivery. A later terminal handling failure
    // invalidates this queued candidate before the existing owner starts its drain.
    runAfterReplyOperationClear(params.operation, () => {
      if (params.operation.result?.kind !== "completed") {
        cancellation.abort();
      }
    });
  }
  return enqueued;
}

import type { EmbeddedAgentRunResult } from "../../agents/embedded-agent-runner/types.js";
import { getRegisteredAgentHarness } from "../../agents/harness/registry.js";
import { accountSessionGoalUsage } from "../../config/sessions/goals-transitions.js";
import { readSessionEntryInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { resolveSessionWorkerPlacementContext } from "../../gateway/session-worker-placement-context.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { formatSystemTurnPrompt } from "../../sessions/system-turn-prompt.js";
import { SkillLibraryError } from "../../skills/library/errors.js";
import { enqueueFollowupRun, getFollowupQueueDepth } from "./queue/enqueue.js";
import { isFollowupRunAborted, type FollowupRun, type QueueSettings } from "./queue/types.js";
import { runAfterReplyOperationClear, type ReplyOperation } from "./reply-run-registry.js";

const log = createSubsystemLogger("auto-reply/goal-continuation");

export type GoalContinuation = Pick<SessionEntry, "sessionId" | "lifecycleRevision"> & {
  goalId: string;
  workerGoal?: true;
  localCodexGoal?: true;
};

/** Resolve the current Codex execution owner without creating a new placement. */
function resolveCodexGoalPlacement(params: {
  agentId?: string;
  sessionKey: string;
  sessionId: string;
  requiresWorker?: boolean;
}): "local" | "worker" | undefined {
  const harness = getRegisteredAgentHarness("codex")?.harness;
  if (!harness) {
    return undefined;
  }
  const placement = resolveSessionWorkerPlacementContext()
    .workerSessionPlacementService?.getMany([params.sessionId])
    .get(params.sessionId);
  if (!placement) {
    return params.requiresWorker ? undefined : "local";
  }
  if (
    placement.agentId !== params.agentId ||
    placement.sessionKey !== params.sessionKey ||
    placement.sessionId !== params.sessionId
  ) {
    return undefined;
  }
  if (placement.state === "local") {
    return params.requiresWorker ? undefined : "local";
  }
  // This release does not have the later worker-transcript continuation owner.
  // Refuse remote placement instead of running its Goal through a local queue.
  return undefined;
}

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
    (entry.agentHarnessId === undefined ||
      entry.agentHarnessId === "openclaw" ||
      (entry.agentHarnessId === "codex" &&
        (continuation.workerGoal === true || continuation.localCodexGoal === true))),
  );
}

export function isGoalContinuationPlacementCurrent(params: {
  continuation: GoalContinuation;
  agentId?: string;
  sessionKey: string;
  hasOperatorAuthority: boolean;
  requiresWorker: boolean;
}): boolean {
  const { continuation } = params;
  if (!continuation.workerGoal && !continuation.localCodexGoal) {
    return true;
  }
  if (!params.hasOperatorAuthority || (continuation.localCodexGoal && params.requiresWorker)) {
    return false;
  }
  const placement = resolveCodexGoalPlacement({
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    sessionId: continuation.sessionId,
    requiresWorker: continuation.workerGoal === true,
  });
  return continuation.workerGoal ? placement === "worker" : placement === "local";
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
type EnqueueGoalContinuationParams = {
  base: FollowupRun;
  result: EmbeddedAgentRunResult;
  initialGoalId?: string;
  expectedSession: Pick<SessionEntry, "sessionId" | "lifecycleRevision">;
  sessionKey: string;
  storePath: string;
  queueKey: string;
  settings: QueueSettings;
  sourceRunId: string;
  operation: ReplyOperation;
  runFollowup: (run: FollowupRun) => Promise<void>;
};

async function enqueueGoalContinuationUnsafe(
  params: EnqueueGoalContinuationParams,
): Promise<boolean> {
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
  const children = listUnsettledRequesterChildren({
    requesterSessionKey: params.sessionKey,
    requesterAgentId: params.base.run.agentId,
  });
  if (children.length > 0 || !eligible()) {
    return false;
  }
  const entry = await readSessionEntryInWorker(
    { storePath: params.storePath, sessionKey: params.sessionKey },
    () => params.base.operatorAuthority?.assertCurrent(),
  );
  params.base.operatorAuthority?.assertCurrent();
  if (!eligible() || !entry?.goal) {
    return false;
  }
  const codexPlacement =
    entry.agentHarnessId === "codex" && params.base.operatorAuthority
      ? resolveCodexGoalPlacement({
          agentId: params.base.run.agentId,
          sessionKey: params.sessionKey,
          sessionId: params.expectedSession.sessionId,
          requiresWorker: false,
        })
      : undefined;
  if (entry.agentHarnessId === "codex" && !codexPlacement) {
    return false;
  }
  params.base.operatorAuthority?.assertCurrent();
  if (!eligible()) {
    return false;
  }
  const continuation: GoalContinuation = {
    ...params.expectedSession,
    goalId: params.initialGoalId ?? entry.goal.id,
    ...(codexPlacement === "worker" ? { workerGoal: true as const } : {}),
    ...(codexPlacement === "local" ? { localCodexGoal: true as const } : {}),
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

/** Goal scheduling is optional and must not change the completed source turn's outcome. */
export async function enqueueGoalContinuation(
  params: EnqueueGoalContinuationParams,
): Promise<boolean> {
  try {
    return await enqueueGoalContinuationUnsafe(params);
  } catch (error) {
    log.warn(`goal continuation scheduling failed: ${formatErrorMessage(error)}`);
    return false;
  }
}

import type { EmbeddedAgentRunResult } from "../../agents/embedded-agent-runner/types.js";
import { getRegisteredAgentHarness } from "../../agents/harness/registry.js";
import { accountSessionGoalUsage } from "../../config/sessions/goals-transitions.js";
import { readSessionEntryReadOnlyInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import type { SessionEntryCohortReader } from "../../config/sessions/session-entry-read-runtime.types.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { getInProcessGatewayRequestContext } from "../../plugins/runtime/gateway-request-scope.js";
import {
  runAfterReplyOperationClear,
  type ReplyOperation,
} from "../../sessions/session-controller.js";
import {
  reserveSessionControllerSource,
  retireSessionControllerInput,
  bindSessionControllerSource,
  type SessionControllerInput,
} from "../../sessions/session-controller.mailbox.js";
import { captureSessionTarget } from "../../sessions/session-controller.target.js";
import { createGoalContinuationReturnScope } from "./goal-continuation-return.js";
import type { GoalContinuation } from "./goal-continuation.types.js";
import { refreshActiveGoalContext } from "./inbound-meta.js";
import { scheduleFollowupDrain } from "./queue/drain.js";
import { enqueueFollowupRun, getFollowupQueueDepth } from "./queue/enqueue.js";
import { isFollowupRunAborted, type FollowupRun, type QueueSettings } from "./queue/types.js";
import { buildTranscriptFollowupRun } from "./transcript-followup-run.js";

export type { GoalContinuation } from "./goal-continuation.types.js";

/** Selects supported Codex placement facts; execution still acquires a fresh turn claim. */
export async function resolveCodexGoalPlacement(params: {
  agentId?: string;
  sessionKey: string;
  sessionId: string;
  requiresWorker?: boolean;
}): Promise<"local" | "worker" | undefined> {
  const harness = getRegisteredAgentHarness("codex")?.harness;
  if (!harness) {
    return undefined;
  }
  const service = getInProcessGatewayRequestContext()?.workerSessionPlacementService;
  const prepared = await service?.prepareSessionPlacement?.(params.sessionId);
  if (!prepared) {
    return params.requiresWorker ? undefined : "local";
  }
  try {
    const pending = prepared.prepareRead();
    if (pending) {
      await pending;
    }
    const placement = prepared.current();
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
    return placement.executionMode === "remote-exec" &&
      harness.cloudPlacement?.mode === "remote-exec"
      ? "worker"
      : undefined;
  } finally {
    prepared.release();
  }
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

/** Revalidates Codex placement at admission; built-in runs have no placement marker. */
export async function isGoalContinuationPlacementCurrent(params: {
  continuation: GoalContinuation;
  agentId?: string;
  sessionKey: string;
  hasOperatorAuthority: boolean;
  requiresWorker: boolean;
}): Promise<boolean> {
  const { continuation } = params;
  if (!continuation.workerGoal && !continuation.localCodexGoal) {
    return true;
  }
  if (!params.hasOperatorAuthority) {
    return false;
  }
  if (continuation.localCodexGoal && params.requiresWorker) {
    return false;
  }
  const placement = await resolveCodexGoalPlacement({
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
type GoalContinuationParams = {
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
  isCurrent?: () => boolean;
  controllerInput?: SessionControllerInput;
  runFollowup: (run: FollowupRun) => Promise<void>;
};

export async function enqueueGoalContinuation(params: GoalContinuationParams): Promise<boolean> {
  const eligible = () =>
    params.isCurrent?.() !== false &&
    !params.controllerInput?.abortSignal.aborted &&
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
  const codexPlacement =
    entry.agentHarnessId === "codex" && params.base.operatorAuthority
      ? await resolveCodexGoalPlacement({
          agentId: params.base.run.agentId,
          sessionKey: params.sessionKey,
          sessionId: params.expectedSession.sessionId,
          requiresWorker: Boolean(params.base.run.config?.cloudWorkers?.requiredProfile),
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
    ...buildTranscriptFollowupRun(base, {
      prompt:
        "Advance the active goal; keep it active until fully achieved. Use the current goal context, and verify the entire objective before marking it complete.",
      sourceTool: "session_goal_continue",
      expiredSkillAuthoringMessage:
        "Skill authoring requires a fresh user request after the previous turn settled.",
    }),
    goalContinuation: continuation,
    summaryLine: "goal-continuation",
    messageId: ["goal", continuation.sessionId, continuation.goalId, params.sourceRunId].join(":"),
    abortSignal: base.abortSignal
      ? AbortSignal.any([base.abortSignal, cancellation.signal])
      : cancellation.signal,
    controllerInput: params.controllerInput,
    strandedReplyRetry: undefined,
    stalledTurnRecovery: undefined,
  };
  if (params.controllerInput) {
    bindSessionControllerSource(params.controllerInput, nudge);
  }
  const enqueued = enqueueFollowupRun(
    params.queueKey,
    nudge,
    params.settings,
    "message-id",
    params.runFollowup,
    false,
    { storePath: params.storePath },
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

/** The queue owner retains only the return from an admitted built-in chat Goal. */
export function createGoalContinuationReturn(
  params: Omit<GoalContinuationParams, "result" | "sourceRunId"> | undefined,
): <T>(run: () => T) => T {
  if (!params?.initialGoalId) {
    return (run) => run();
  }
  const continuation: GoalContinuation = {
    sessionId: params.expectedSession.sessionId,
    lifecycleRevision: params.expectedSession.lifecycleRevision,
    goalId: params.initialGoalId,
  };
  return createGoalContinuationReturnScope({
    base: params.base,
    sessionKey: params.sessionKey,
    continuation,
    operation: params.operation,
    context: (entry, existing) =>
      isGoalContinuationCurrent(continuation, entry)
        ? refreshActiveGoalContext(existing, entry)
        : undefined,
    async resume({ base, runId, result, isCurrent }) {
      // The controller sees this pending input before admission reads yield to Stop.
      const input = reserveSessionControllerSource(params.queueKey, {
        policy: params.settings,
        target: captureSessionTarget({
          storeScope: params.storePath,
          sessionKey: params.sessionKey,
          agentId: base.run.agentId,
          incarnation: continuation.sessionId,
        }),
        adapter: {
          scope: params.storePath,
          authority: base.operatorAuthority,
          signal: base.abortSignal,
        },
      });
      let enqueued = false;
      try {
        enqueued = await enqueueGoalContinuation({
          ...params,
          base,
          result,
          sourceRunId: runId,
          expectedSession: continuation,
          initialGoalId: continuation.goalId,
          reader: undefined,
          controllerInput: input,
          isCurrent,
        });
        if (enqueued) {
          scheduleFollowupDrain(params.queueKey, params.runFollowup);
        }
      } finally {
        if (!enqueued) {
          retireSessionControllerInput(input);
        }
      }
    },
  });
}

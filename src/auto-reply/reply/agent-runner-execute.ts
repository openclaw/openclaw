import crypto from "node:crypto";
import { appendCurrentInboundContext } from "../../agents/embedded-agent-runner/run/runtime-context-prompt.js";
import type { SessionEntry } from "../../config/sessions.js";
import { withBeforeAgentReplyObserver } from "../../plugins/before-agent-reply.js";
import { getGatewayContextResolver } from "../../plugins/runtime/gateway-request-scope.js";
import { readPendingUserTurnTranscriptAdmission } from "../../sessions/user-turn-transcript-admission.js";
import { setReplyPayloadMetadata } from "../reply-payload.js";
import { SILENT_REPLY_TOKEN } from "../tokens.js";
import type { ReplyPayload } from "../types.js";
import {
  resolveReplyRunDeliveryContext,
  resolveSourceReplyPolicy,
  scheduleFollowupDrainAfterReplyOperationClear,
  type RunReplyAgentParams,
} from "./agent-runner-core.js";
import { executeAgentTurn } from "./agent-runner-execution.js";
import { markPostCompactionModelFailurePayload } from "./agent-runner-failure-reply.js";
import { runMemoryFlushIfNeeded, runSessionCompactionIfNeeded } from "./agent-runner-memory.js";
import { accountAgentTurnCompaction } from "./agent-runner-result-accounting.js";
import { finalizeReplyAgentRun } from "./agent-runner-result.js";
import type { FinalizeReplyAgentRunInput } from "./agent-runner-result.types.js";
import type { CompactionNoticePhase } from "./compaction-notice.js";
import { createFollowupRunner } from "./followup-runner.js";
import {
  buildRecoverablePendingFinalDeliveryText,
  normalizePendingFinalDeliveryPayloads,
} from "./pending-final-delivery.js";
import { claimNextQueuedFollowupRequestFrom, enqueueFollowupRun } from "./queue.js";
import {
  isReplyOperationSuperseded,
  resolveReplyOperationAbortReason,
} from "./reply-operation-abort.js";
import {
  recordReplyOperationAgentTurn,
  resolveReplyOperationRunState,
} from "./reply-operation-run-state.js";
import type { ReplyOperation } from "./reply-run-registry.js";
import { createReplyRestartRecoveryClaimController } from "./restart-recovery-claim.js";
import { buildStalledTurnRecoveryRun, STALLED_TURN_GUIDANCE } from "./stalled-turn-recovery.js";

export function prependCompactionNotices(
  result: ReplyPayload | ReplyPayload[] | undefined,
  notices: readonly ReplyPayload[],
  operation: ReplyOperation,
): ReplyPayload | ReplyPayload[] | undefined {
  if (notices.length === 0 || resolveReplyOperationAbortReason(operation)) {
    return result;
  }
  return [...notices, ...(Array.isArray(result) ? result : result ? [result] : [])];
}

/** Continues a saved stalled request once, retaining its final-feedback obligation. */
export function continueStalledReplyTurn({
  followupRun,
  queueKey,
  resolvedQueue,
  replyOperation,
  runFollowupTurn,
  guidance,
}: Pick<RunReplyAgentParams, "followupRun" | "queueKey" | "resolvedQueue"> & {
  replyOperation: ReplyOperation;
  runFollowupTurn: FinalizeReplyAgentRunInput["runFollowupTurn"];
  guidance?: string;
}): boolean {
  // Preflight can stall before admission persists the request. Transcript-only
  // recovery cannot answer that input; leave its notice with dispatch.
  if (
    followupRun.stalledTurnRecovery ||
    followupRun.userTurnTranscriptRecorder?.hasPersisted() !== true
  ) {
    return false;
  }
  try {
    followupRun.operatorAuthority?.assertCurrent();
  } catch {
    return false;
  }
  const queuedRequest = !guidance && claimNextQueuedFollowupRequestFrom(queueKey, followupRun);
  if (queuedRequest) {
    // The handoff owns the same last-resort feedback as a dedicated recovery.
    queuedRequest.stalledTurnRecovery = true;
    followupRun.stalledTurnRecovery = true;
    queuedRequest.currentInboundContext = appendCurrentInboundContext(
      queuedRequest.currentInboundContext,
      [{ kind: "runtime-instruction", text: STALLED_TURN_GUIDANCE }],
    );
    return true;
  }
  // Group-thread participants declare no queued reply owner, so a recovery's
  // answer would be dropped; leave the notice with the stalled turn's dispatch.
  if (followupRun.queuedFollowupReplyDisposition?.kind === "drop") {
    return false;
  }
  const enqueued = enqueueFollowupRun(
    queueKey,
    buildStalledTurnRecoveryRun(followupRun, guidance),
    resolvedQueue,
    "none",
    runFollowupTurn,
    false,
    { position: "front" },
  );
  if (enqueued) {
    followupRun.stalledTurnRecovery = true;
    scheduleFollowupDrainAfterReplyOperationClear({
      operation: replyOperation,
      queueKey,
      runFollowup: runFollowupTurn,
    });
  }
  return enqueued;
}

type ExecutePreparedReplyAgentRunInput = Omit<
  FinalizeReplyAgentRunInput,
  "activeSessionEntry" | "preflightCompactionApplied" | "execution" | "runId" | "runStartedAt"
> &
  Pick<
    RunReplyAgentParams,
    "blockReplyChunking" | "toolProgressDetail" | "transcriptCommandBody" | "typing" | "typingMode"
  > & {
    admitUserTurn: ReturnType<typeof createReplyRestartRecoveryClaimController>["admitUserTurn"];
    applyReplyToMode: (payload: ReplyPayload) => ReplyPayload;
    beginBeforeAgentReply: ReturnType<
      typeof createReplyRestartRecoveryClaimController
    >["beginBeforeAgentReply"];
    checkpointBeforeAgentReply: ReturnType<
      typeof createReplyRestartRecoveryClaimController
    >["checkpointBeforeAgentReply"];
    resolveVisibleReplyDelivery: () => Promise<boolean>;
    getActiveSessionEntry: () => SessionEntry | undefined;
    isRestartRecoveryArmed: () => Promise<boolean>;
    sendDirectCompactionNotice: ((phase: CompactionNoticePhase) => Promise<void>) | undefined;
    onCompactionNoticePayload?: (payload: ReplyPayload) => void;
    setRunFollowupTurn: (runner: FinalizeReplyAgentRunInput["runFollowupTurn"]) => void;
    setActiveSessionEntry: (entry: SessionEntry | undefined) => void;
    shouldEmitToolOutput: () => boolean;
    shouldEmitToolResult: () => boolean;
    traceAgentPhase: <T>(name: string, run: () => Promise<T> | T) => Promise<T>;
    turnAdoptionLifecycle: NonNullable<RunReplyAgentParams["opts"]>["turnAdoptionLifecycle"];
  };

export async function executePreparedReplyAgentRun(
  input: ExecutePreparedReplyAgentRunInput,
): Promise<ReplyPayload | ReplyPayload[] | undefined> {
  // Preserve the invocation snapshot across preparation; live session state uses its getters.
  const context = { ...input };
  const {
    activeSessionStore,
    admitUserTurn,
    beginBeforeAgentReply,
    checkpointBeforeAgentReply,
    defaultModel,
    followupRun,
    getActiveSessionEntry,
    opts,
    replyOperation,
    replyThreadingOverride,
    returnWithQueuedFollowupDrain,
    sendDirectCompactionNotice,
    sessionCtx,
    sessionKey,
    setActiveSessionEntry,
    setRunFollowupTurn,
    storePath,
    toolProgressDetail,
    traceAgentPhase,
    turnAdoptionLifecycle,
    typing,
    typingMode,
    typingSignals,
  } = context;
  let activeSessionEntry = getActiveSessionEntry();

  await typingSignals.signalRunStart();

  const preflightAdmission = readPendingUserTurnTranscriptAdmission(
    followupRun.userTurnTranscriptRecorder,
  );
  const checkpointMemory = async (entry: SessionEntry) => {
    const flushed = await traceAgentPhase("reply.memory_flush", () =>
      runMemoryFlushIfNeeded({
        ...context,
        preflightAdmission,
        promptForEstimate: followupRun.prompt,
        sessionEntry: entry,
        sessionStore: activeSessionStore,
      }),
    );
    setActiveSessionEntry(flushed.sessionEntry);
    replyOperation.abortSignal.throwIfAborted();
    if (flushed.outcome === "exhausted") {
      await sendDirectCompactionNotice?.("memory_flush_degraded");
    }
    return flushed.sessionEntry;
  };

  const prePreflightCompactionCount = activeSessionEntry?.compactionCount ?? 0;
  activeSessionEntry = await traceAgentPhase("reply.preflight_compaction", () =>
    runSessionCompactionIfNeeded({
      ...context,
      replyOperation,
      pendingUserEntryId: preflightAdmission?.entryId,
      promptForEstimate: followupRun.prompt,
      sessionEntry: activeSessionEntry,
      sessionStore: activeSessionStore,
      abortSignal: replyOperation.abortSignal,
      beforeCompaction: checkpointMemory,
      onCompactionStart: () => replyOperation.setPhase("preflight_compacting"),
      onSessionIdChanged: (sessionId) => replyOperation.updateSessionId(sessionId),
      onCompactionNotice: sendDirectCompactionNotice,
    }),
  );
  setActiveSessionEntry(activeSessionEntry);
  const preflightCompactionApplied =
    (activeSessionEntry?.compactionCount ?? 0) > prePreflightCompactionCount;

  const runFollowupTurn = createFollowupRunner({
    resolveGatewayContext: getGatewayContextResolver(replyOperation),
    opts,
    typing,
    typingMode,
    sessionEntry: activeSessionEntry,
    sessionStore: activeSessionStore,
    sessionKey,
    storePath,
    defaultModel,
    toolProgressDetail,
  });
  setRunFollowupTurn(runFollowupTurn);

  replyOperation.setPhase("running");
  const runStartedAt = Date.now();
  const userTurnAdmission = await admitUserTurn(followupRun.userTurnTranscriptRecorder);
  activeSessionEntry = getActiveSessionEntry();
  if (userTurnAdmission === "duplicate-source") {
    return returnWithQueuedFollowupDrain(undefined);
  }
  // Adoption marks run start and must never be spool-replayed (would re-run tools).
  // New input and its recovery claim share admission; otherwise lifecycle start owns the claim.
  await turnAdoptionLifecycle?.onAdopted();
  const runOutcome = await withBeforeAgentReplyObserver(
    {
      beforeDispatch: async () => {
        const result = await beginBeforeAgentReply();
        activeSessionEntry = getActiveSessionEntry();
        return result;
      },
      afterDispatch: async (hookResult) => {
        if (!hookResult?.handled) {
          await checkpointBeforeAgentReply({ state: undefined });
          activeSessionEntry = getActiveSessionEntry();
          return hookResult;
        }
        const hookReply = hookResult.reply ?? { text: SILENT_REPLY_TOKEN };
        const hookFinalDeliveryText = buildRecoverablePendingFinalDeliveryText([hookReply]);
        const normalizedHookReplies = normalizePendingFinalDeliveryPayloads([hookReply]);
        let hookCheckpoint: Parameters<typeof checkpointBeforeAgentReply>[0] = {
          state: normalizedHookReplies.length === 0 ? "handled-silent" : "pending",
        };
        if (sessionKey && storePath && normalizedHookReplies.length > 0) {
          const sourceReplyPolicy = resolveSourceReplyPolicy({
            ...context,
            sessionKey,
            sessionEntry: activeSessionEntry,
          });
          if (!sourceReplyPolicy.suppressDelivery) {
            const pendingFinalDeliveryIntentId = crypto.randomUUID();
            const pendingFinalDeliveryDeliveryId = crypto.randomUUID();
            setReplyPayloadMetadata(hookReply, {
              pendingFinalDeliveryCompletion: {
                agentId: followupRun.run.agentId,
                deliveryId: pendingFinalDeliveryDeliveryId,
                intentId: pendingFinalDeliveryIntentId,
                ...(activeSessionEntry?.restartRecoveryDeliveryRunId
                  ? { recoveryRunId: activeSessionEntry.restartRecoveryDeliveryRunId }
                  : {}),
                sessionId: replyOperation.sessionId,
                sessionKey,
                storePath,
              },
            });
            hookCheckpoint = {
              state: "handled-reply",
              pendingFinalDelivery: {
                text: hookFinalDeliveryText ?? "",
                intentId: pendingFinalDeliveryIntentId,
                deliveries: [{ id: pendingFinalDeliveryDeliveryId, state: "prepared" }],
                context: resolveReplyRunDeliveryContext({
                  ...context,
                  sessionKey,
                  sessionEntry: activeSessionEntry,
                }),
              },
            };
          } else {
            // dispatch-from-config owns source visibility for every returned payload.
            // This checkpoint records that recovery owes no delivery; the outer gate drops the reply.
            hookCheckpoint = { state: "handled-silent" };
          }
        }
        await checkpointBeforeAgentReply(hookCheckpoint);
        activeSessionEntry = getActiveSessionEntry();
        return { ...hookResult, reply: hookReply };
      },
    },
    () =>
      traceAgentPhase("reply.run_agent_turn", () =>
        executeAgentTurn({
          ...context,
          resolveVisibleReplyDelivery: input.resolveVisibleReplyDelivery,
          replyThreading: replyThreadingOverride ?? sessionCtx.ReplyThreading,
        }),
      ),
  );
  const operationSuperseded = isReplyOperationSuperseded(replyOperation);
  recordReplyOperationAgentTurn(
    followupRun.replyOperationRunStates,
    replyOperation,
    runOutcome.outcome,
  );
  activeSessionEntry = getActiveSessionEntry();

  if (runOutcome.outcome.kind !== "settled") {
    // Only captured facts cross cancellation; no successor adoption, hooks, or reply work.
    await accountAgentTurnCompaction({
      compaction: runOutcome.outcome.compaction,
      sessionStore: activeSessionStore,
      replyOperation,
    });
  }
  if (operationSuperseded) {
    return { text: SILENT_REPLY_TOKEN };
  }
  if (runOutcome.outcome.kind !== "settled") {
    if (
      runOutcome.outcome.kind === "rejected" &&
      !replyOperation.result &&
      resolveReplyOperationRunState(opts)?.replyCompletion?.outcome !== "pending"
    ) {
      replyOperation.fail("run_failed", new Error("reply operation exited with final payload"));
    }
    return returnWithQueuedFollowupDrain(
      runOutcome.outcome.kind === "rejected"
        ? markPostCompactionModelFailurePayload(
            runOutcome.outcome.postCompactionModelFailure,
            runOutcome.outcome.payload,
          )
        : { text: SILENT_REPLY_TOKEN },
    );
  }

  const result = await finalizeReplyAgentRun({
    ...context,
    activeSessionEntry,
    preflightCompactionApplied,
    runFollowupTurn,
    execution: runOutcome.outcome,
    runId: runOutcome.runId,
    runStartedAt,
  });
  const { postCompactionModelFailure } = runOutcome.outcome;
  if (Array.isArray(result)) {
    return result.map((payload) =>
      markPostCompactionModelFailurePayload(postCompactionModelFailure, payload),
    );
  }
  return result
    ? markPostCompactionModelFailurePayload(postCompactionModelFailure, result)
    : result;
}

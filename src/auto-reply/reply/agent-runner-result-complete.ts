import crypto from "node:crypto";
import type { SessionEntry } from "../../config/sessions.js";
import { updateSessionEntry } from "../../config/sessions/session-accessor.js";
import { emitContinuationCompactionReleasedSpan } from "../../infra/continuation-tracer.js";
import { defaultRuntime } from "../../runtime.js";
import { sessionDeliveryChannel } from "../../utils/delivery-context.shared.js";
import { DEFAULT_HEARTBEAT_ACK_MAX_CHARS, stripHeartbeatToken } from "../heartbeat.js";
import { setReplyPayloadMetadata } from "../reply-payload.js";
import type { ReplyPayload } from "../types.js";
import { scheduleReplyContinuation } from "./agent-runner-continuation-schedule.js";
import {
  markBeforeAgentRunBlockedPayloads,
  resolveReplyRunDeliveryContext,
  resolveSourceReplyPolicy,
  normalizeAssistantFinalDeliveryText,
} from "./agent-runner-core.js";
import { scheduleReplySessionMaintenance } from "./agent-runner-maintenance.js";
import type { accountAgentTurn } from "./agent-runner-result-accounting.js";
import { buildReplyDiagnosticsPayload } from "./agent-runner-result-diagnostics.js";
import type { FinalizeReplyAgentRunInput } from "./agent-runner-result.types.js";
import { appendUsageLine } from "./agent-runner-usage-line.js";
import {
  buildRecoverablePendingFinalDeliveryText,
  normalizePendingFinalDeliveryPayloads,
  normalizePendingFinalRecoveryPayloads,
} from "./pending-final-delivery.js";
import { dispatchPostCompactionDelegates } from "./post-compaction-delegate-dispatch.js";
import { warnPrivateMessageToolFinal } from "./private-message-tool-final.js";
import { enqueueFollowupRun, refreshQueuedFollowupSession } from "./queue.js";
import {
  buildStrandedReplyDeliveryFailurePayload,
  resolveStrandedReplyRecovery,
} from "./stranded-reply-recovery.js";
type ReplyAgentAccounting = Awaited<ReturnType<typeof accountAgentTurn>>;
type PreparedReplyAgentPayloads = {
  kind: "continue";
  activeSessionEntry: SessionEntry | undefined;
  completedSourceReplyDelivery: boolean;
  guardedReplyPayloads: ReplyPayload[];
  responseUsageLine: string | undefined;
  wasSilentContinuation: boolean;
};

export async function completeReplyAgentRun(input: {
  context: FinalizeReplyAgentRunInput;
  accounting: ReplyAgentAccounting;
  prepared: PreparedReplyAgentPayloads;
}) {
  const { context, accounting, prepared } = input;
  const {
    activeIsNewSession,
    activeSessionStore,
    cfg,
    continuation,
    execution,
    followupRun,
    getActiveSessionEntry,
    isHeartbeat,
    opts,
    preflightCompactionApplied,
    queueKey,
    resolvedBlockStreamingBreak,
    resolvedQueue,
    resolvedVerboseLevel,
    returnWithQueuedFollowupDrain,
    runFollowupTurn,
    runtimePolicySessionKey,
    sessionCtx,
    sessionKey,
    setActiveSessionEntry,
    storePath,
  } = context;
  const {
    autoCompactionCount,
    continuationExtractionFromBracket,
    continuationWorkReason,
    effectiveContinuationSignal,
    effectiveContinueWorkRequests,
    internalBracketTraceparent,
    runId,
    runResult,
    usage,
    verboseEnabled,
  } = accounting;
  const {
    completedSourceReplyDelivery,
    guardedReplyPayloads,
    responseUsageLine,
    wasSilentContinuation,
  } = prepared;
  let { activeSessionEntry } = prepared;

  // Prepend verbose operational notices. Model fallback notices are prepared
  // earlier so they pass through normal reply threading and stream-dedupe.
  let finalPayloads = guardedReplyPayloads;
  const prefixNotices: ReplyPayload[] = [];

  if (verboseEnabled && activeIsNewSession) {
    prefixNotices.push({ text: `🧭 New session: ${followupRun.run.sessionId}` });
  }

  if (autoCompactionCount > 0) {
    const previousSessionId = accounting.expectedSession.sessionId;
    const count = accounting.compactionCount;
    const refreshedSessionEntry =
      sessionKey && activeSessionStore ? activeSessionStore[sessionKey] : undefined;
    if (refreshedSessionEntry) {
      activeSessionEntry = refreshedSessionEntry;
      refreshQueuedFollowupSession({
        key: queueKey,
        previousSessionId,
        nextSessionId: refreshedSessionEntry.sessionId,
        nextSessionFile: queueKey,
      });
    }

    // Inject post-compaction workspace context for the next agent turn,
    // and dispatch any staged continuation post-compaction delegates.
    // The dispatch helper internally awaits readPostCompactionContext
    // against followupRun.run.workspaceDir and enqueues the resulting system
    // event, so we don't call it again here. That await also carries upstream's
    // sequencing fix (context injection is no longer fire-and-forget).
    if (sessionKey) {
      const releasedCount = activeSessionEntry?.pendingPostCompactionDelegates?.length ?? 0;
      await dispatchPostCompactionDelegates({
        cfg,
        compactionCount: count,
        continuationSignalKind: effectiveContinuationSignal?.kind,
        followupRun,
        postCompactionDelegatesToPreserve: continuation.postCompactionDelegatesToPreserve,
        sessionEntry: activeSessionEntry,
        sessionKey,
        sessionStore: activeSessionStore,
        storePath,
      });
      emitContinuationCompactionReleasedSpan({
        releasedCount,
        compactionId: count,
        traceparent: execution.compactionTraceparent,
        log: (message) => defaultRuntime.log(message),
      });
    }

    if (verboseEnabled) {
      const suffix = typeof count === "number" ? ` (count ${count})` : "";
      prefixNotices.push({ text: `🧹 Auto-compaction complete${suffix}.` });
    }
  }
  // Skip verbose/usage augmentation for silent continuations — a bare
  // CONTINUE_WORK should produce no user-visible output.
  const isHookBlockedRun = runResult.meta?.error?.kind === "hook_block";
  const rawAssistantText = isHookBlockedRun
    ? undefined
    : (runResult.meta?.finalAssistantRawText ?? runResult.meta?.finalAssistantVisibleText);
  if (!wasSilentContinuation) {
    const prefixPayloads = [...prefixNotices];
    const trailingPluginStatusPayload = await buildReplyDiagnosticsPayload({
      activeSessionEntry,
      followupRun,
      accounting,
      cfg,
      storePath,
      userText:
        sessionCtx.commandText ||
        sessionCtx.agentText ||
        sessionCtx.CommandBody ||
        sessionCtx.RawBody ||
        sessionCtx.BodyForAgent ||
        sessionCtx.Body,
      resolvedVerboseLevel,
      resolvedBlockStreamingBreak,
      preflightCompactionApplied,
    });
    if (prefixPayloads.length > 0) {
      finalPayloads = [...prefixPayloads, ...finalPayloads];
    }
    if (trailingPluginStatusPayload) {
      finalPayloads = [...finalPayloads, trailingPluginStatusPayload];
    }
    if (responseUsageLine) {
      finalPayloads = appendUsageLine(finalPayloads, responseUsageLine);
    }
    if (isHookBlockedRun) {
      finalPayloads = markBeforeAgentRunBlockedPayloads(finalPayloads);
    }
  }

  setActiveSessionEntry(activeSessionEntry);
  await scheduleReplyContinuation({
    cfg,
    sessionKey,
    followupRun,
    runId,
    usage,
    effectiveContinuationSignal,
    continuationExtractionFromBracket,
    effectiveContinueWorkRequests,
    continuationWorkReason,
    internalBracketTraceparent,
    continuation,
    getActiveSessionEntry,
  });
  activeSessionEntry = getActiveSessionEntry() ?? activeSessionEntry;

  // Silent continuations should produce no user-visible output.
  if (wasSilentContinuation) {
    return returnWithQueuedFollowupDrain(undefined);
  }

  if (finalPayloads.length === 0 && effectiveContinuationSignal) {
    return returnWithQueuedFollowupDrain(undefined);
  }

  // Capture only policy-visible final payloads in session store to support
  // durable delivery retries. Hidden reasoning, message-tool-only replies,
  // and sendPolicy-denied replies must not become heartbeat-replayable text.
  const isStrandedReplyRetryRun = followupRun.strandedReplyRetry === true;
  if (sessionKey && storePath && (finalPayloads.length > 0 || isStrandedReplyRetryRun)) {
    const sourceReplyPolicy = resolveSourceReplyPolicy({
      cfg,
      sessionCtx,
      sessionEntry: activeSessionEntry,
      sessionKey,
      runtimePolicySessionKey,
      opts,
    });
    // #85714: warn only for unusually substantive private final text. In
    // message_tool_only, no tool call can be intentional silence, and
    // final payloads also include verbose/status/usage metadata.
    const assistantFinalText = normalizeAssistantFinalDeliveryText(
      typeof runResult.meta?.finalAssistantVisibleText === "string"
        ? runResult.meta.finalAssistantVisibleText
        : (rawAssistantText ?? ""),
    );
    // Heartbeats already deliver fallback finals via sendDurableMessageBatch;
    // recovering here would duplicate that message.
    const recovery = resolveStrandedReplyRecovery({
      base: followupRun,
      finalText: assistantFinalText,
      sourceReplyDeliveryMode: sourceReplyPolicy.sourceReplyDeliveryMode,
      sendPolicyDenied: sourceReplyPolicy.sendPolicyDenied,
      successfulSourceReplyDelivery: completedSourceReplyDelivery,
      isHeartbeat,
      isRoomEvent: sessionCtx.InboundEventKind === "room_event",
    });
    if (recovery.kind === "retry" || (recovery.kind === "diagnostic" && recovery.warn)) {
      warnPrivateMessageToolFinal({
        sessionKey,
        channel:
          sessionCtx.OriginatingChannel ??
          sessionCtx.Surface ??
          sessionCtx.Provider ??
          sessionDeliveryChannel(activeSessionEntry),
        finalTextLength: assistantFinalText.trim().length,
      });
    }
    if (recovery.kind === "diagnostic") {
      finalPayloads = [...finalPayloads, recovery.payload];
    } else if (recovery.kind === "retry") {
      const retryEnqueued = enqueueFollowupRun(
        queueKey,
        recovery.run,
        resolvedQueue,
        "none",
        runFollowupTurn,
        false,
        { position: "front" },
      );
      if (!retryEnqueued) {
        finalPayloads = [...finalPayloads, buildStrandedReplyDeliveryFailurePayload()];
      }
    }
    const recoverablePendingFinalText = buildRecoverablePendingFinalDeliveryText(
      normalizePendingFinalRecoveryPayloads(finalPayloads),
    );
    const pendingText = sourceReplyPolicy.suppressDelivery
      ? ""
      : (recoverablePendingFinalText ?? "");
    const heartbeatAckMaxChars = DEFAULT_HEARTBEAT_ACK_MAX_CHARS;
    const resolvedPendingText = isHeartbeat
      ? (() => {
          const stripped = stripHeartbeatToken(pendingText, {
            mode: "heartbeat",
            maxAckChars: heartbeatAckMaxChars,
          });
          return stripped.shouldSkip ? "" : stripped.text || pendingText;
        })()
      : pendingText;
    const sendableFinalPayloads = sourceReplyPolicy.suppressDelivery
      ? []
      : finalPayloads.filter(
          (payload) => normalizePendingFinalDeliveryPayloads([payload]).length > 0,
        );
    if (sendableFinalPayloads.length > 0) {
      const pendingFinalDeliveryIntentId = crypto.randomUUID();
      const expectedSessionId = activeSessionEntry?.sessionId ?? followupRun.run.sessionId;
      const pendingFinalDeliveries = sendableFinalPayloads.map((payload) => {
        const deliveryId = crypto.randomUUID();
        setReplyPayloadMetadata(payload, {
          pendingFinalDeliveryCompletion: {
            deliveryId,
            intentId: pendingFinalDeliveryIntentId,
            ...(activeSessionEntry?.restartRecoveryDeliveryRunId
              ? { recoveryRunId: activeSessionEntry.restartRecoveryDeliveryRunId }
              : {}),
            sessionId: expectedSessionId,
            sessionKey,
            storePath,
          },
        });
        return { id: deliveryId, state: "prepared" as const };
      });
      const pendingFinalDeliveryContext = resolveReplyRunDeliveryContext({
        cfg,
        sessionCtx,
        sessionEntry: activeSessionEntry,
        sessionKey,
        runtimePolicySessionKey,
        opts,
      });
      // A reset can rebind the key while the model runs; its replacement must
      // never inherit the old run's final or advertise an uncommitted intent.
      const persistedPendingFinalDelivery = await updateSessionEntry(
        { storePath, sessionKey },
        (entry) =>
          entry.sessionId === expectedSessionId
            ? {
                pendingFinalDelivery: {
                  ...(resolvedPendingText
                    ? { kind: "replayable" as const, text: resolvedPendingText }
                    : { kind: "transport-only" as const }),
                  intentId: pendingFinalDeliveryIntentId,
                  deliveries: pendingFinalDeliveries,
                  context: pendingFinalDeliveryContext,
                  createdAt: Date.now(),
                },
                updatedAt: Date.now(),
              }
            : null,
        {
          skipMaintenance: true,
          takeCacheOwnership: true,
        },
      );
      if (
        persistedPendingFinalDelivery?.sessionId !== expectedSessionId ||
        persistedPendingFinalDelivery.pendingFinalDelivery?.intentId !==
          pendingFinalDeliveryIntentId
      ) {
        throw new Error("pending final delivery session changed or was deleted");
      }
    }
  }
  const result = returnWithQueuedFollowupDrain(
    finalPayloads.length === 1 ? finalPayloads[0] : finalPayloads,
  );
  scheduleReplySessionMaintenance({ context, accounting, sessionEntry: activeSessionEntry });
  return result;
}

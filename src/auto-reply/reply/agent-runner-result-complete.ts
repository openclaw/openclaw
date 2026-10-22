import crypto from "node:crypto";
import { OPENCLAW_AGENT_RUNTIME_ID } from "../../agents/agent-runtime-id.js";
import { createMissingReplyNotice } from "../../agents/reply-completion.js";
import {
  createSessionMaintenanceFollowup,
  scheduleSessionMaintenance,
} from "../../agents/session-maintenance/run.js";
import { withSystemEventOwner } from "../../infra/system-event-ownership.js";
import { enqueueSystemEvent } from "../../infra/system-events.js";
import { sessionDeliveryChannel } from "../../utils/delivery-context.read.js";
import { getCommandOwnerAuthority } from "../command-owner-authority.js";
import { getReplyPayloadMetadata, setReplyPayloadMetadata } from "../reply-payload.js";
import type { ReplyPayload } from "../types.js";
import {
  markBeforeAgentRunBlockedPayloads,
  resolveReplyRunDeliveryContext,
  resolveSourceReplyPolicy,
  normalizeAssistantFinalDeliveryText,
} from "./agent-runner-core.js";
import type { AccountedAgentTurn } from "./agent-runner-result-accounting.js";
import { buildReplyDiagnosticsPayload } from "./agent-runner-result-diagnostics.js";
import type { prepareReplyAgentPayloads } from "./agent-runner-result-payloads.js";
import type { FinalizeReplyAgentRunInput } from "./agent-runner-result.types.js";
import { appendUsageLine } from "./agent-runner-usage-line.js";
import {
  buildRecoverablePendingFinalDeliveryText,
  normalizePendingFinalDeliveryPayloads,
  normalizePendingFinalRecoveryPayloads,
} from "./pending-final-delivery.js";
import { readPostCompactionContext } from "./post-compaction-context.js";
import { warnPrivateMessageToolFinal } from "./private-message-tool-final.js";
import { enqueueFollowupRun, refreshQueuedFollowupSession } from "./queue.js";
import { isInternalSourceReplyChannel } from "./source-reply-delivery-mode.js";
import { resolveStrandedReplyRecovery } from "./stranded-reply-recovery.js";

export async function completeReplyAgentRun(input: {
  context: FinalizeReplyAgentRunInput;
  accounting: AccountedAgentTurn;
  prepared: Extract<Awaited<ReturnType<typeof prepareReplyAgentPayloads>>, { kind: "continue" }>;
}) {
  const { context, accounting, prepared } = input;
  const {
    activeIsNewSession,
    activeSessionStore,
    cfg,
    followupRun,
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
    storePath,
  } = context;
  const { autoCompactionCount, runResult, verboseEnabled } = accounting;
  const { completion } = context;
  const { completedSourceReplyDelivery, guardedReplyPayloads, responseUsageLine } = prepared;
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

    if (sessionKey) {
      const contextContent = await readPostCompactionContext(followupRun.run.workspaceDir, {
        cfg,
        agentId: followupRun.run.agentId,
      });
      if (contextContent) {
        enqueueSystemEvent(
          contextContent,
          withSystemEventOwner({ sessionKey }, followupRun.run.agentId),
        );
      }
    }

    if (verboseEnabled) {
      const suffix = count !== undefined ? ` (count ${count})` : "";
      prefixNotices.push(
        setReplyPayloadMetadata(
          { text: `🧹 Auto-compaction complete${suffix}.` },
          { hostNotice: true },
        ),
      );
    }
  }
  const trailingPluginStatusPayload = await buildReplyDiagnosticsPayload({
    activeSessionEntry,
    followupRun,
    accounting,
    cfg,
    storePath,
    userText: sessionCtx.commandText || sessionCtx.agentText,
    resolvedVerboseLevel,
    resolvedBlockStreamingBreak,
    preflightCompactionApplied,
  });
  const isHookBlockedRun = runResult.meta?.error?.kind === "hook_block";
  const rawAssistantText = isHookBlockedRun
    ? undefined
    : (runResult.meta?.finalAssistantRawText ?? runResult.meta?.finalAssistantVisibleText);
  if (prefixNotices.length > 0) {
    finalPayloads = [...prefixNotices, ...finalPayloads];
  }
  if (trailingPluginStatusPayload) {
    finalPayloads = [...finalPayloads, trailingPluginStatusPayload];
  }
  const resolveReplyPolicy = (resolvedSessionKey: string) =>
    resolveSourceReplyPolicy({
      cfg,
      sessionCtx,
      sessionEntry: activeSessionEntry,
      sessionKey: resolvedSessionKey,
      runtimePolicySessionKey,
      opts,
    });
  const sourceReplyPolicy = sessionKey ? resolveReplyPolicy(sessionKey) : undefined;
  if (responseUsageLine) {
    finalPayloads = appendUsageLine(finalPayloads, responseUsageLine, {
      completedSourceReply:
        sourceReplyPolicy?.sourceReplyDeliveryMode === "message_tool_only" &&
        completedSourceReplyDelivery &&
        prepared.replyCompletion.outcome === "delivered",
    });
  }
  if (isHookBlockedRun) {
    finalPayloads = markBeforeAgentRunBlockedPayloads(finalPayloads);
  }

  // Capture only policy-visible final payloads in session store to support
  // durable delivery retries. Hidden reasoning, message-tool-only replies,
  // and sendPolicy-denied replies must not become replayable text.
  const isStrandedReplyRetryRun = followupRun.strandedReplyRetry === true;
  if (
    sessionKey &&
    storePath &&
    runResult.meta?.terminalReply?.disposition !== "silent" &&
    prepared.replyCompletion.outcome !== "silent" &&
    (finalPayloads.length > 0 ||
      isStrandedReplyRetryRun ||
      runResult.meta?.terminalReply !== undefined)
  ) {
    const recoverySourceReplyPolicy = sourceReplyPolicy ?? resolveReplyPolicy(sessionKey);
    const assistantFinalText = normalizeAssistantFinalDeliveryText(
      runResult.meta?.finalAssistantVisibleText ?? rawAssistantText ?? "",
    );
    const recovery =
      prepared.replyCompletion.outcome === "pending"
        ? { kind: "none" as const }
        : resolveStrandedReplyRecovery({
            base: followupRun,
            payloads: finalPayloads,
            finalText: assistantFinalText,
            terminalReply: runResult.meta?.terminalReply,
            sourceReplyDeliveryMode: recoverySourceReplyPolicy.sourceReplyDeliveryMode,
            sendPolicyDenied: recoverySourceReplyPolicy.sendPolicyDenied,
            successfulSourceReplyDelivery: completedSourceReplyDelivery,
            isRoomEvent: sessionCtx.InboundEventKind === "room_event",
          });
    if (recovery.kind === "retry") {
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
        { ...recovery.run, controllerInput: undefined, controllerClaim: undefined },
        resolvedQueue,
        "none",
        runFollowupTurn,
        false,
        { position: "front", storePath },
      );
      if (!retryEnqueued) {
        finalPayloads = [...finalPayloads, createMissingReplyNotice()];
      }
    }
    const recoverablePendingFinalText = buildRecoverablePendingFinalDeliveryText(
      normalizePendingFinalRecoveryPayloads(finalPayloads),
    );
    const pendingText = recoverySourceReplyPolicy.suppressDelivery
      ? ""
      : (recoverablePendingFinalText ?? "");
    // Committed text/media needs no second delivery state machine; other parts still do.
    const canUseLocalTranscript =
      isInternalSourceReplyChannel(sessionCtx) && !prepared.reminderNoteAppended;
    const sendableFinalPayloads = recoverySourceReplyPolicy.suppressDelivery
      ? []
      : finalPayloads.filter((payload) => {
          const metadata = getReplyPayloadMetadata(payload);
          const committedSourceReply =
            metadata?.sourceReplyTranscriptMirror?.transcriptOwner === true;
          const committedLocalContent =
            canUseLocalTranscript &&
            (metadata?.localTranscriptDeliveryConfirmed === true || committedSourceReply) &&
            !metadata?.assistantMediaFailures?.length &&
            (committedSourceReply || (!payload.mediaUrl && !payload.mediaUrls?.length)) &&
            !payload.attachments?.length &&
            !payload.presentation &&
            !payload.interactive &&
            !payload.channelData &&
            !payload.location &&
            !payload.btw &&
            !payload.delivery &&
            !payload.spokenText &&
            !payload.ttsSupplement &&
            !metadata?.responsePrefix &&
            !metadata?.responseUsageLine;
          return (
            !committedLocalContent && normalizePendingFinalDeliveryPayloads([payload]).length > 0
          );
        });
    if (sendableFinalPayloads.length > 0) {
      const commandOwner = getCommandOwnerAuthority(followupRun.run);
      const commandOwnerReference = commandOwner
        ? (commandOwner.recoveryReference ?? null)
        : undefined;
      const pendingFinalDeliveryIntentId = crypto.randomUUID();
      const expectedSessionId = activeSessionEntry?.sessionId ?? followupRun.run.sessionId;
      const pendingFinalDeliveries = sendableFinalPayloads.map((payload) => {
        const deliveryId = crypto.randomUUID();
        setReplyPayloadMetadata(payload, {
          pendingFinalDeliveryCompletion: {
            commandOwnerReference,
            agentId: followupRun.run.agentId,
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
      if (!completion) {
        throw new Error("Pending final delivery has no admitted completion actor");
      }
      const persistedPendingFinalDelivery = await completion.complete({
        ...(pendingText && commandOwnerReference === undefined
          ? { kind: "replayable" as const, text: pendingText }
          : { kind: "transport-only" as const }),
        intentId: pendingFinalDeliveryIntentId,
        deliveries: pendingFinalDeliveries,
        context: pendingFinalDeliveryContext,
        createdAt: Date.now(),
      });
      if (
        persistedPendingFinalDelivery?.sessionId !== expectedSessionId ||
        persistedPendingFinalDelivery.pendingFinalDelivery?.intentId !==
          pendingFinalDeliveryIntentId
      ) {
        throw new Error("pending final delivery session changed or was deleted");
      }
      activeSessionEntry = persistedPendingFinalDelivery;
    }
  }
  activeSessionEntry = (await completion?.complete()) ?? activeSessionEntry;
  const result = returnWithQueuedFollowupDrain(
    finalPayloads.length <= 1 ? finalPayloads[0] : finalPayloads,
  );
  const { replyOperation } = context;
  const meta = runResult.meta;
  const auth = context.execution.maintenanceAuthProfile;
  if (
    !activeSessionEntry ||
    !sessionKey ||
    !storePath ||
    !accounting.providerUsed ||
    !replyOperation.lifecycleGeneration ||
    accounting.preserveUserFacingSessionState ||
    context.execution.status !== "ok" ||
    accounting.fallbackExhausted ||
    autoCompactionCount > 0 ||
    meta?.aborted ||
    meta?.yielded ||
    meta?.error ||
    meta?.agentMeta?.agentHarnessId !== OPENCLAW_AGENT_RUNTIME_ID ||
    auth === undefined ||
    cfg.agents?.defaults?.compaction?.enabled === false
  ) {
    return result;
  }
  const maintenancePrepared = {
    cfg,
    sessionKey,
    storePath,
    timeoutMs: followupRun.run.timeoutMs,
    runtimePolicySessionKey,
  };
  // The descriptor has no foreground authority; delivery settlement gates its new owner.
  scheduleSessionMaintenance(
    {
      prepared: maintenancePrepared,
      followupRun: createSessionMaintenanceFollowup({
        run: followupRun.run,
        sessionEntry: activeSessionEntry,
        cfg,
        sessionKey,
        runtimePolicySessionKey: runtimePolicySessionKey ?? followupRun.run.runtimePolicySessionKey,
        provider: accounting.providerUsed,
        model: accounting.modelUsed,
        auth,
      }),
      sessionId: activeSessionEntry.sessionId,
      lifecycleRevision: activeSessionEntry.lifecycleRevision,
      lifecycleGeneration: replyOperation.lifecycleGeneration,
      startedAt: replyOperation.startedAtMs,
      agentHarnessId: meta.agentMeta.agentHarnessId,
      compactionRequestBudget: context.execution.compactionRequestBudget,
    },
    replyOperation.ownerSettlement.then(
      () => replyOperation.result?.kind === "completed" && !replyOperation.abortSignal.aborted,
    ),
  );
  return result;
}

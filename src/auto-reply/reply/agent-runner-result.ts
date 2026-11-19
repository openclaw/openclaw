import crypto from "node:crypto";
import { OPENCLAW_AGENT_RUNTIME_ID } from "../../agents/agent-runtime-id.js";
import { createMissingReplyNotice } from "../../agents/reply-completion.js";
import {
  createSessionMaintenanceFollowup,
  prepareSessionMaintenanceRequest,
  scheduleSessionMaintenance,
} from "../../agents/session-maintenance/run.js";
import { emitContinuationCompactionReleasedSpan } from "../../infra/continuation-tracer.js";
import { defaultRuntime } from "../../runtime.js";
import { getReplyOperationSessionReader } from "../../sessions/session-controller.state.js";
import { sessionDeliveryChannel } from "../../utils/delivery-context.read.js";
import { getCommandOwnerAuthority } from "../command-owner-authority.js";
import { getReplyPayloadMetadata, setReplyPayloadMetadata } from "../reply-payload.js";
import type { ReplyPayload } from "../types.js";
import { withAgentTurnCompletion } from "./agent-runner-completion.js";
import { scheduleReplyContinuation } from "./agent-runner-continuation-schedule.js";
import {
  markBeforeAgentRunBlockedPayloads,
  resolveReplyRunDeliveryContext,
  resolveSourceReplyPolicy,
  normalizeAssistantFinalDeliveryText,
} from "./agent-runner-core.js";
import { accountAgentTurn } from "./agent-runner-result-accounting.js";
import { buildReplyDiagnosticsPayload } from "./agent-runner-result-diagnostics.js";
import { prepareReplyAgentPayloads } from "./agent-runner-result-payloads.js";
import type { FinalizeReplyAgentRunInput } from "./agent-runner-result.types.js";
import { appendUsageLine } from "./agent-runner-usage-line.js";
import { readCreatedGoalContinuationId } from "./goal-continuation-return.js";
import { enqueueGoalContinuation } from "./goal-continuation.js";
import {
  buildRecoverablePendingFinalDeliveryText,
  normalizePendingFinalDeliveryPayloads,
  normalizePendingFinalRecoveryPayloads,
} from "./pending-final-delivery.js";
import { dispatchPostCompactionDelegates } from "./post-compaction-delegate-dispatch.js";
import { warnPrivateMessageToolFinal } from "./private-message-tool-final.js";
import { enqueueFollowupRun, refreshQueuedFollowupSession } from "./queue.js";
import { isInternalSourceReplyChannel } from "./source-reply-delivery-mode.js";
import { resolveStrandedReplyRecovery } from "./stranded-reply-recovery.js";

export async function finalizeReplyAgentRun(
  context: FinalizeReplyAgentRunInput,
): Promise<ReplyPayload | ReplyPayload[] | undefined> {
  const initialGoal = context.activeSessionEntry?.goal;
  // A completed predecessor must not fence a new goal created by this user turn.
  const initialGoalId =
    readCreatedGoalContinuationId(context.runId, context.replyOperation) ??
    (initialGoal?.status === "complete" ? undefined : initialGoal?.id);
  const { result, accounting: completedAccounting } = await withAgentTurnCompletion(
    {
      agentId: context.followupRun.run.agentId,
      storePath: context.storePath,
      sessionKey: context.sessionKey,
      entry: context.activeSessionEntry,
      writer: context.execution.sessionWriter,
      operation: context.replyOperation,
      activitySummaryCompletion: context.activitySummaryCompletion,
      publish(entry) {
        context.activeSessionEntry = entry;
        if (context.activeSessionStore && context.sessionKey) {
          context.activeSessionStore[context.sessionKey] = entry;
        }
      },
    },
    async (completion) => {
      const current = { ...context, completion };
      const accounting = await accountAgentTurn(current);
      const prepared = await prepareReplyAgentPayloads({ context: current, accounting });
      if (prepared.kind === "return") {
        const diagnostics = await buildReplyDiagnosticsPayload({
          activeSessionEntry: accounting.activeSessionEntry,
          followupRun: context.followupRun,
          accounting,
          cfg: context.cfg,
          storePath: context.storePath,
          userText: context.sessionCtx.commandText || context.sessionCtx.agentText,
          resolvedVerboseLevel: context.resolvedVerboseLevel,
          resolvedBlockStreamingBreak: context.resolvedBlockStreamingBreak,
          preflightCompactionApplied: context.preflightCompactionApplied,
        });
        await completion?.complete();
        if (!diagnostics) {
          return { result: prepared.value, accounting };
        }
        return {
          result: prepared.value
            ? [...(Array.isArray(prepared.value) ? prepared.value : [prepared.value]), diagnostics]
            : diagnostics,
          accounting,
        };
      }
      const {
        activeIsNewSession,
        activeSessionStore,
        cfg,
        continuation,
        execution,
        followupRun,
        getActiveSessionEntry,
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
      } = current;
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
          const { queuedDelegates } = await dispatchPostCompactionDelegates({
            cfg,
            compactionCount: count,
            continuationSignalKind: effectiveContinuationSignal?.kind,
            followupRun,
            postCompactionDelegatesToPreserve: continuation.postCompactionDelegatesToPreserve,
            releaseTraceparent: execution.compactionTraceparent,
            sessionEntry: activeSessionEntry,
            sessionKey,
            sessionStore: activeSessionStore,
            storePath,
          });
          emitContinuationCompactionReleasedSpan({
            releasedCount: queuedDelegates,
            compactionId: count,
            traceparent: execution.compactionTraceparent,
            log: (message) => defaultRuntime.log(message),
          });
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
      // Skip verbose/usage augmentation for silent continuations — a bare
      // CONTINUE_WORK should produce no user-visible output.
      const isHookBlockedRun = runResult.meta?.error?.kind === "hook_block";
      const rawAssistantText = isHookBlockedRun
        ? undefined
        : (runResult.meta?.finalAssistantRawText ?? runResult.meta?.finalAssistantVisibleText);
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
      if (!wasSilentContinuation) {
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
        if (prefixNotices.length > 0) {
          finalPayloads = [...prefixNotices, ...finalPayloads];
        }
        if (trailingPluginStatusPayload) {
          finalPayloads = [...finalPayloads, trailingPluginStatusPayload];
        }
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
      }

      // Arm continuation only after the terminal completion commits, so a wake is never
      // visible for a turn whose bookkeeping or final custody rolled back.
      const settleAndScheduleContinuation = async () => {
        activeSessionEntry = (await completion?.complete()) ?? activeSessionEntry;
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
      };

      // Silent continuations should produce no user-visible output.
      if (wasSilentContinuation) {
        await settleAndScheduleContinuation();
        return { result: returnWithQueuedFollowupDrain(undefined), accounting };
      }

      if (finalPayloads.length === 0 && effectiveContinuationSignal) {
        await settleAndScheduleContinuation();
        return { result: returnWithQueuedFollowupDrain(undefined), accounting };
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
                !committedLocalContent &&
                normalizePendingFinalDeliveryPayloads([payload]).length > 0
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
      await settleAndScheduleContinuation();
      const reply = returnWithQueuedFollowupDrain(
        finalPayloads.length <= 1 ? finalPayloads[0] : finalPayloads,
      );
      const { replyOperation } = current;
      const meta = runResult.meta;
      const auth = current.execution.maintenanceAuthProfile;
      if (
        !activeSessionEntry ||
        !sessionKey ||
        !storePath ||
        !accounting.providerUsed ||
        !replyOperation.lifecycleGeneration ||
        accounting.preserveUserFacingSessionState ||
        current.execution.status !== "ok" ||
        accounting.fallbackExhausted ||
        autoCompactionCount > 0 ||
        meta?.aborted ||
        meta?.yielded ||
        meta?.error ||
        meta?.agentMeta?.agentHarnessId !== OPENCLAW_AGENT_RUNTIME_ID ||
        auth === undefined ||
        cfg.agents?.defaults?.compaction?.enabled === false
      ) {
        return { result: reply, accounting };
      }
      const maintenancePrepared = {
        cfg,
        sessionKey,
        storePath,
        timeoutMs: followupRun.run.timeoutMs,
        runtimePolicySessionKey,
      };
      // The descriptor has no foreground authority; delivery settlement gates its new owner.
      const maintenanceRequest = await prepareSessionMaintenanceRequest({
        prepared: maintenancePrepared,
        followupRun: createSessionMaintenanceFollowup({
          run: followupRun.run,
          sessionEntry: activeSessionEntry,
          cfg,
          sessionKey,
          runtimePolicySessionKey:
            runtimePolicySessionKey ?? followupRun.run.runtimePolicySessionKey,
          provider: accounting.providerUsed,
          model: accounting.modelUsed,
          auth,
        }),
        sessionId: activeSessionEntry.sessionId,
        lifecycleRevision: activeSessionEntry.lifecycleRevision,
        lifecycleGeneration: replyOperation.lifecycleGeneration,
        startedAt: replyOperation.startedAtMs,
        agentHarnessId: meta.agentMeta.agentHarnessId,
        compactionRequestBudget: current.execution.compactionRequestBudget,
      });
      if (maintenanceRequest) {
        scheduleSessionMaintenance(
          maintenanceRequest,
          replyOperation.ownerSettlement.then(
            () =>
              replyOperation.result?.kind === "completed" && !replyOperation.abortSignal.aborted,
          ),
        );
      }
      return { result: reply, accounting };
    },
  );
  if (
    context.sessionKey &&
    context.storePath &&
    context.execution.status === "ok" &&
    completedAccounting.activeSessionEntry?.goal?.status === "active"
  ) {
    await enqueueGoalContinuation({
      base: context.followupRun,
      result: completedAccounting.runResult,
      initialGoalId,
      expectedSession: completedAccounting.expectedSession,
      sessionKey: context.sessionKey,
      storePath: context.storePath,
      reader: getReplyOperationSessionReader(context.replyOperation),
      queueKey: context.queueKey,
      settings: context.resolvedQueue,
      sourceRunId: context.runId,
      operation: context.replyOperation,
      runFollowup: context.runFollowupTurn,
    });
  }
  return context.returnWithQueuedFollowupDrain(result);
}

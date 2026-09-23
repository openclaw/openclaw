import crypto from "node:crypto";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import { withBeforeAgentReplyObserver } from "../../plugins/before-agent-reply.js";
import { getGatewayContextResolver } from "../../plugins/runtime/gateway-request-scope.js";
import { readPendingUserTurnTranscriptAdmission } from "../../sessions/user-turn-transcript-admission.js";
import { isInternalMessageChannel } from "../../utils/message-channel.js";
import { setReplyPayloadMetadata } from "../reply-payload.js";
import { SILENT_REPLY_TOKEN } from "../tokens.js";
import type { ReplyPayload } from "../types.js";
import {
  resolveReplyRunDeliveryContext,
  resolveSourceReplyPolicy,
  type RunReplyAgentParams,
} from "./agent-runner-core.js";
import { executeAgentTurn } from "./agent-runner-execution.js";
import { markPostCompactionModelFailurePayload } from "./agent-runner-failure-reply.js";
import { runMemoryFlushIfNeeded, runSessionCompactionIfNeeded } from "./agent-runner-memory.js";
import { accountAgentTurnCompaction } from "./agent-runner-result-accounting.js";
import { finalizeReplyAgentRun } from "./agent-runner-result.js";
import type { FinalizeReplyAgentRunInput } from "./agent-runner-result.types.js";
import { buildThreadingToolContext } from "./agent-runner-utils.js";
import type { CompactionNoticePhase } from "./compaction-notice.js";
import { createFollowupRunner } from "./followup-runner.js";
import {
  buildRecoverablePendingFinalDeliveryText,
  normalizePendingFinalDeliveryPayloads,
} from "./pending-final-delivery.js";
import { isReplyOperationSuperseded } from "./reply-operation-abort.js";
import { recordReplyOperationAgentTurn } from "./reply-operation-run-state.js";
import type { ReplyOperation } from "./reply-run-registry.js";
import { replyRunRegistry } from "./reply-run-registry.js";
import { createReplyRestartRecoveryClaimController } from "./restart-recovery-claim.js";
type ExecutePreparedReplyAgentRunInput = Omit<
  FinalizeReplyAgentRunInput,
  | "activeIsNewSession"
  | "activeSessionEntry"
  | "preflightCompactionApplied"
  | "execution"
  | "runId"
  | "runStartedAt"
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
    getActiveIsNewSession: () => boolean;
    getActiveSessionEntry: () => SessionEntry | undefined;
    isRestartRecoveryArmed: () => boolean;
    resetSessionAfterRoleOrderingConflict: (reason: string) => Promise<boolean>;
    sendDirectCompactionNotice: ((phase: CompactionNoticePhase) => Promise<void>) | undefined;
    setRunFollowupTurn: (runner: FinalizeReplyAgentRunInput["runFollowupTurn"]) => void;
    setActiveSessionEntry: (entry: SessionEntry | undefined) => void;
    shouldEmitToolOutput: () => boolean;
    shouldEmitToolResult: () => boolean;
    traceAgentPhase: <T>(name: string, run: () => Promise<T> | T) => Promise<T>;
    turnAdoptionLifecycle: NonNullable<RunReplyAgentParams["opts"]>["turnAdoptionLifecycle"];
  };

function markPostCompactionFailureResult(
  result: ReplyPayload | ReplyPayload[] | undefined,
  postCompactionModelFailure: true | undefined,
): ReplyPayload | ReplyPayload[] | undefined {
  if (Array.isArray(result)) {
    return result.map((payload) =>
      markPostCompactionModelFailurePayload(postCompactionModelFailure, payload),
    );
  }
  return result
    ? markPostCompactionModelFailurePayload(postCompactionModelFailure, result)
    : result;
}

export async function executePreparedReplyAgentRun(
  input: ExecutePreparedReplyAgentRunInput,
): Promise<ReplyPayload | ReplyPayload[] | undefined> {
  // Preserve the invocation snapshot across preparation; live session state uses its getters.
  const context = { ...input };
  const {
    activeSessionStore,
    admitUserTurn: admitUserTurnWithRecovery,
    beginBeforeAgentReply: beginBeforeAgentReplyWithRecovery,
    cfg,
    checkpointBeforeAgentReply: checkpointBeforeAgentReplyWithRecovery,
    defaultModel,
    followupRun,
    getActiveIsNewSession,
    getActiveSessionEntry,
    opts,
    replyOperation,
    replyThreadingOverride,
    returnWithQueuedFollowupDrain,
    runtimePolicySessionKey,
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
  const admitUserTurn = async (
    ...args: Parameters<typeof admitUserTurnWithRecovery>
  ): ReturnType<typeof admitUserTurnWithRecovery> => {
    const result = await admitUserTurnWithRecovery(...args);
    activeSessionEntry = getActiveSessionEntry();
    return result;
  };
  const beginBeforeAgentReply = async (
    ...args: Parameters<typeof beginBeforeAgentReplyWithRecovery>
  ): ReturnType<typeof beginBeforeAgentReplyWithRecovery> => {
    const result = await beginBeforeAgentReplyWithRecovery(...args);
    activeSessionEntry = getActiveSessionEntry();
    return result;
  };
  const checkpointBeforeAgentReply = async (
    ...args: Parameters<typeof checkpointBeforeAgentReplyWithRecovery>
  ): ReturnType<typeof checkpointBeforeAgentReplyWithRecovery> => {
    const result = await checkpointBeforeAgentReplyWithRecovery(...args);
    activeSessionEntry = getActiveSessionEntry();
    return result;
  };

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
  if (userTurnAdmission === "duplicate-source") {
    return returnWithQueuedFollowupDrain(undefined);
  }
  // Adoption marks run start and must never be spool-replayed (would re-run tools).
  // Suppressed delivery persists only the user transcript; crashed suppressed runs die
  // silently. Deliverable turns atomically persist transcript plus recovery ownership.
  await turnAdoptionLifecycle?.onAdopted();
  const runOutcome = await withBeforeAgentReplyObserver(
    {
      beforeDispatch: async () => {
        return await beginBeforeAgentReply();
      },
      afterDispatch: async (hookResult) => {
        if (!hookResult?.handled) {
          await checkpointBeforeAgentReply({ state: undefined });
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
            cfg,
            sessionCtx,
            sessionEntry: activeSessionEntry,
            sessionKey,
            runtimePolicySessionKey,
            opts,
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
                  cfg,
                  sessionCtx,
                  sessionEntry: activeSessionEntry,
                  sessionKey,
                  runtimePolicySessionKey,
                  opts,
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
  const activeIsNewSession = getActiveIsNewSession();

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
    if (runOutcome.outcome.kind === "rejected" && !replyOperation.result) {
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
    activeIsNewSession,
    activeSessionEntry,
    preflightCompactionApplied,
    runFollowupTurn,
    execution: runOutcome.outcome,
    runId: runOutcome.runId,
    runStartedAt,
  });
  return markPostCompactionFailureResult(result, runOutcome.outcome.postCompactionModelFailure);
}

export function createReplyAgentRestartRecoveryController(
  context: Pick<
    RunReplyAgentParams,
    "followupRun" | "opts" | "runtimePolicySessionKey" | "sessionCtx" | "sessionKey" | "storePath"
  > & {
    activeSessionStore: Record<string, SessionEntry> | undefined;
    cfg: OpenClawConfig;
    getActiveSessionEntry: () => SessionEntry | undefined;
    replyOperation: ReplyOperation;
    restartRecoverySourceTurnId: string | undefined;
    setActiveSessionEntry: (entry: SessionEntry) => void;
  },
) {
  const {
    activeSessionStore,
    cfg,
    followupRun,
    getActiveSessionEntry,
    opts,
    replyOperation,
    restartRecoverySourceTurnId,
    runtimePolicySessionKey,
    sessionCtx,
    sessionKey,
    setActiveSessionEntry,
    storePath,
  } = context;

  const restartRecoverySameChannelThreadRequired = restartRecoverySourceTurnId
    ? buildThreadingToolContext({
        sessionCtx,
        config: cfg,
        hasRepliedRef: undefined,
      }).sameChannelThreadRequired
    : undefined;
  const admissionRunId =
    normalizeOptionalString(sessionCtx.MessageSid) ??
    normalizeOptionalString(sessionCtx.MessageSidFull);
  const {
    admitUserTurn,
    beginBeforeAgentReply,
    checkpointBeforeAgentReply,
    clear: clearRestartRecoveryDeliveryClaim,
    isArmed: isRestartRecoveryArmed,
  } = createReplyRestartRecoveryClaimController({
    agentId: followupRun.run.agentId,
    lifecycleGeneration: replyOperation.lifecycleGeneration,
    admissionRunId,
    getEntry: () =>
      sessionKey
        ? (activeSessionStore?.[sessionKey] ?? getActiveSessionEntry())
        : getActiveSessionEntry(),
    getSessionId: () => replyOperation.sessionId,
    isRestartAbort: () =>
      replyOperation.result?.kind === "aborted" &&
      replyOperation.result.code === "aborted_for_restart",
    resolveDeliveryContext: (entry) =>
      sessionKey
        ? resolveReplyRunDeliveryContext({
            cfg,
            sessionCtx,
            sessionEntry: entry,
            sessionKey,
            runtimePolicySessionKey,
            opts,
          })
        : undefined,
    requesterAccountId:
      followupRun.originatingAccountId ?? sessionCtx.AccountId ?? followupRun.run.agentAccountId,
    requesterSenderId: sessionCtx.SenderId,
    resolveUserTurnTarget: ({
      entry,
      sessionId,
      sessionKey: targetSessionKey,
      storePath: targetStorePath,
    }) => ({
      sessionId,
      sessionKey: targetSessionKey,
      sessionEntry: entry,
      ...(activeSessionStore ? { sessionStore: activeSessionStore } : {}),
      storePath: targetStorePath,
      agentId: followupRun.run.agentId,
      cwd: followupRun.run.workspaceDir,
      config: cfg,
    }),
    ...(sessionKey ? { sessionKey } : {}),
    setEntry: (entry) => {
      setActiveSessionEntry(entry);
      if (activeSessionStore && sessionKey) {
        activeSessionStore[sessionKey] = entry;
      }
    },
    sameChannelThreadRequired: restartRecoverySameChannelThreadRequired,
    sourceTurnId: restartRecoverySourceTurnId,
    sourceReplyDeliveryMode: sessionKey
      ? resolveSourceReplyPolicy({
          cfg,
          sessionCtx,
          sessionEntry: getActiveSessionEntry(),
          sessionKey,
          runtimePolicySessionKey,
          opts,
        }).sourceReplyDeliveryMode
      : opts?.sourceReplyDeliveryMode,
    ...(storePath ? { storePath } : {}),
  });
  const admitUserTurnWithSourceBinding: typeof admitUserTurn = async (...args) => {
    const result = await admitUserTurn(...args);
    if (result === "admitted") {
      let sourceTurnId = restartRecoverySourceTurnId;
      if (
        !sourceTurnId &&
        admissionRunId &&
        isInternalMessageChannel(sessionCtx.Provider ?? sessionCtx.Surface)
      ) {
        const entry = getActiveSessionEntry();
        // Gateway inputs use run IDs, not channel hashes. Recovery retains the
        // admitted source so historical terminal receipts cannot fence a later turn.
        sourceTurnId =
          entry?.restartRecoveryDeliveryRunId === admissionRunId
            ? (normalizeOptionalString(entry?.restartRecoveryDeliverySourceRunId) ?? admissionRunId)
            : admissionRunId;
      }
      if (sourceTurnId) {
        replyRunRegistry.bindSourceTurnId(replyOperation, sourceTurnId);
      }
    }
    return result;
  };
  return {
    admitUserTurn: admitUserTurnWithSourceBinding,
    beginBeforeAgentReply,
    checkpointBeforeAgentReply,
    clear: clearRestartRecoveryDeliveryClaim,
    isArmed: isRestartRecoveryArmed,
  };
}

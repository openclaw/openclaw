import crypto from "node:crypto";
import { resolveContextTokensForModel } from "../../agents/context.js";
import { DEFAULT_CONTEXT_TOKENS } from "../../agents/defaults.js";
import { appendCurrentInboundContext } from "../../agents/embedded-agent-runner/run/runtime-context-prompt.js";
import { evaluateRequestCompactionGuards } from "../../agents/tools/request-compaction-tool.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withBeforeAgentReplyObserver } from "../../plugins/before-agent-reply.js";
import { getGatewayContextResolver } from "../../plugins/runtime/gateway-request-scope.js";
import { defaultRuntime } from "../../runtime.js";
import type { ReplyOperation } from "../../sessions/session-controller.js";
import { withCurrentUserTurnInput } from "../../sessions/user-turn-transcript-runtime-context.js";
import type { UserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.types.js";
import { resolveLiveContinuationRuntimeConfig } from "../continuation/config.js";
import {
  checkContextPressure,
  emitPersistedContextPressure,
  resolveRecordedToolNames,
} from "../continuation/context-pressure.js";
import { setReplyPayloadMetadata } from "../reply-payload.js";
import type { ReplyPayload } from "../types.js";
import {
  resolveReplyRunDeliveryContext,
  resolveSourceReplyPolicy,
  scheduleFollowupDrainAfterReplyOperationClear,
  type RunReplyAgentParams,
} from "./agent-runner-core.js";
import { executeAgentTurn } from "./agent-runner-execution.js";
import { markPostCompactionModelFailurePayload } from "./agent-runner-failure-reply.js";
import {
  followupRunsBuiltInCompaction,
  resolveFollowupAgentRuntimeId,
  resolveFollowupContextTokens,
} from "./agent-runner-memory-runtime.js";
import { computeRequestCompactionContextUsage } from "./agent-runner-post-compaction-release.js";
import { accountAgentTurnCompaction } from "./agent-runner-result-accounting.js";
import { finalizeReplyAgentRun } from "./agent-runner-result.js";
import type { FinalizeReplyAgentRunInput } from "./agent-runner-result.types.js";
import { createFollowupRunner } from "./followup-runner.js";
import { createGoalContinuationReturn } from "./goal-continuation.js";
import { resolveBuiltInCompactionTrigger } from "./memory-flush-plan.js";
import { evaluateNoOpRearmAdmission, type NoOpRearmWakeClass } from "./no-op-rearm-guard.js";
import {
  buildRecoverablePendingFinalDeliveryText,
  normalizePendingFinalDeliveryPayloads,
} from "./pending-final-delivery.js";
import {
  claimNextQueuedFollowupRequestFrom,
  enqueueFollowupRun,
  type FollowupRun,
} from "./queue.js";
import { admitFollowupRunLifecycle } from "./queue/lifecycle.js";
import type { PendingReplyDelivery } from "./reply-input-admission.js";
import {
  isReplyOperationSuperseded,
  resolveReplyOperationAbortReason,
} from "./reply-operation-abort.js";
import {
  recordReplyOperationAgentTurn,
  resolveReplyOperationRunState,
} from "./reply-operation-run-state.js";
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
  // A rerun would hit the same saturated quota.
  if (replyOperation.staleExpiryReason === "rate_limited") {
    return false;
  }
  // Preflight can stall before admission persists the request. Transcript-only
  // recovery cannot answer that input; leave its notice with dispatch.
  if (
    followupRun.stalledTurnRecovery ||
    followupRun.userTurnTranscriptRecorder?.hasPersisted() !== true
  ) {
    return false;
  }
  try {
    followupRun.operatorAuthority?.signal?.throwIfAborted();
    followupRun.operatorAuthority?.assertCurrent();
  } catch {
    // Refusing this continuation does not revoke or settle any queued source.
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
    {
      position: "front",
      storePath: followupRun.controllerInput?.mailbox.owner.target?.storeScope,
    },
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
  | "activeSessionEntry"
  | "preflightCompactionApplied"
  | "execution"
  | "noOpRearmWakeClass"
  | "replySessionKey"
  | "runId"
  | "runStartedAt"
> &
  Pick<
    RunReplyAgentParams,
    "blockReplyChunking" | "toolProgressDetail" | "transcriptCommandBody" | "typing" | "typingMode"
  > & {
    admitUserTurn: (recorder?: UserTurnTranscriptRecorder) => Promise<void>;
    applyReplyToMode: (payload: ReplyPayload) => ReplyPayload;
    recordPendingDelivery: (delivery: PendingReplyDelivery) => Promise<void>;
    resolveVisibleReplyDelivery: () => Promise<boolean>;
    getActiveSessionEntry: () => SessionEntry | undefined;
    isContinuationWake: boolean;
    onCompactionNoticePayload: (payload: ReplyPayload) => void;
    preflightCompactionApplied: boolean;
    recoveryMemoryFlushAttempted?: boolean;
    setRunFollowupTurn: (runner: FinalizeReplyAgentRunInput["runFollowupTurn"]) => void;
    shouldEmitToolOutput: () => boolean;
    shouldEmitToolResult: () => boolean;
    traceAgentPhase: <T>(name: string, run: () => Promise<T> | T) => Promise<T>;
  };

/** The built-in runtime warns from the trigger preflight compaction uses; others keep window ratios. */
function resolveBuiltInContextPressure(params: {
  cfg: OpenClawConfig;
  defaultModel: string;
  followupRun: FollowupRun;
  sessionEntry: SessionEntry;
  sessionKey: string;
}) {
  const { cfg, followupRun, sessionEntry, sessionKey } = params;
  const runtimeId = resolveFollowupAgentRuntimeId(params);
  if (!followupRunsBuiltInCompaction(params, runtimeId)) {
    return undefined;
  }
  const { provider } = followupRun.run;
  const model = followupRun.run.model ?? params.defaultModel;
  const contextWindowTokens = resolveFollowupContextTokens(params, runtimeId);
  return {
    contextWindowTokens,
    compactionTriggerTokens: resolveBuiltInCompactionTrigger({
      cfg,
      contextWindowTokens,
      provider,
      modelId: model,
    }),
    admittedToolNames: resolveRecordedToolNames(sessionEntry),
    isRequestCompactionAdmitted: (entry: SessionEntry) =>
      evaluateRequestCompactionGuards({
        sessionKey,
        contextUsageOrigin: "live_runner",
        getContextUsage: () =>
          computeRequestCompactionContextUsage({ entry, cfg, provider, model }),
      }).admitted,
  };
}

export async function executePreparedReplyAgentRun(
  context: ExecutePreparedReplyAgentRunInput,
): Promise<ReplyPayload | ReplyPayload[] | undefined> {
  const onAgentRunTerminalOutcome = context.opts?.onAgentRunTerminalOutcome;
  let terminalOutcome: "completed" | "failed" | undefined;
  const executionOpts = onAgentRunTerminalOutcome
    ? {
        ...context.opts,
        onAgentRunTerminalOutcome: (outcome: "completed" | "failed") => {
          terminalOutcome = outcome === "failed" ? outcome : (terminalOutcome ?? outcome);
        },
      }
    : context.opts;
  const activitySummaryCompletion =
    context.sessionKey && context.storePath
      ? getGatewayContextResolver(
          context.replyOperation,
        )?.()?.sessionActivitySummaries?.beginCompletion(
          {
            agentId: context.followupRun.run.agentId,
            key: context.sessionKey,
            storePath: context.storePath,
          },
          context.getActiveSessionEntry(),
        )
      : undefined;
  try {
    return await executePreparedReplyAgentRunWithCompletion(
      { ...context, activitySummaryCompletion },
      executionOpts,
    );
  } catch (error) {
    if (terminalOutcome !== undefined) {
      terminalOutcome = "failed";
    }
    throw error;
  } finally {
    activitySummaryCompletion?.release();
    if (terminalOutcome) {
      onAgentRunTerminalOutcome?.(terminalOutcome);
    }
  }
}

async function executePreparedReplyAgentRunWithCompletion(
  context: ExecutePreparedReplyAgentRunInput,
  executionOpts: ExecutePreparedReplyAgentRunInput["opts"],
): Promise<ReplyPayload | ReplyPayload[] | undefined> {
  const {
    activeSessionStore,
    admitUserTurn,
    recordPendingDelivery,
    cfg,
    continuation,
    defaultModel,
    followupRun,
    getActiveSessionEntry,
    isContinuationWake,
    opts,
    replyOperation,
    replyThreadingOverride,
    returnWithQueuedFollowupDrain,
    preflightCompactionApplied,
    sessionCtx,
    sessionKey,
    setRunFollowupTurn,
    storePath,
    toolProgressDetail,
    traceAgentPhase,
    typing,
    typingMode,
  } = context;
  let activeSessionEntry = getActiveSessionEntry();

  // Queued turns outlive this invocation and must not inherit its terminal buffer.
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
  const replySessionKey = sessionKey ?? followupRun.run.sessionKey;
  // Evaluate continuation context pressure and persist the early-warning band
  // before the provider request. Must run for every turn (not only continuation
  // wakes) so the next turn's pre-provider gate sees an up-to-date band.
  activeSessionEntry = getActiveSessionEntry() ?? activeSessionEntry;
  if (activeSessionEntry && sessionKey) {
    const { enabled, contextPressureThreshold, earlyWarningBand } =
      resolveLiveContinuationRuntimeConfig(cfg);
    const pressure = {
      sessionEntry: activeSessionEntry,
      sessionKey,
      agentId: followupRun.run.agentId,
      contextPressureThreshold,
      contextWindowTokens:
        resolveContextTokensForModel({
          cfg,
          provider: followupRun.run.provider,
          model: defaultModel,
          fallbackContextTokens: activeSessionEntry.contextTokens ?? DEFAULT_CONTEXT_TOKENS,
          allowAsyncLoad: false,
        }) ?? DEFAULT_CONTEXT_TOKENS,
      earlyWarningBand,
      postCompaction: preflightCompactionApplied,
      ...(enabled
        ? resolveBuiltInContextPressure({
            cfg,
            defaultModel,
            followupRun,
            sessionEntry: activeSessionEntry,
            sessionKey,
          })
        : undefined),
    };
    if (storePath) {
      try {
        await emitPersistedContextPressure({
          ...pressure,
          continuationEnabled: enabled,
          storePath,
          expectedSessionId: activeSessionEntry.sessionId,
        });
      } catch (err) {
        defaultRuntime.log(`context-pressure band persistence failed (non-fatal): ${String(err)}`);
      }
    } else if (enabled) {
      checkContextPressure(pressure);
    }
  }

  await continuation.resetContinuationChainForFreshTurn();
  activeSessionEntry = getActiveSessionEntry() ?? activeSessionEntry;

  const runStartedAt = Date.now();
  await admitUserTurn(followupRun.userTurnTranscriptRecorder);
  activeSessionEntry = getActiveSessionEntry();

  // Pre-provider no-op replay guard. This is the visible-turn and
  // continuation (getReplyFromConfig) provider path; suppress a self-rearm wake
  // before buying the turn when the per-session no-op streak is tripped. The
  // finally block completes the reply operation and typing on the early return.
  let noOpRearmWakeClass: NoOpRearmWakeClass | undefined;
  if (replySessionKey) {
    const admission = evaluateNoOpRearmAdmission({
      sessionKey: replySessionKey,
      provenance: followupRun.run.inputProvenance,
      inboundEventKind: followupRun.currentInboundEventKind,
      messageId: followupRun.messageId,
      eventTimestampMs: followupRun.currentInboundEventTimestampMs,
      isContinuationWake,
    });
    noOpRearmWakeClass = admission.wake;
    if (!admission.admit) {
      if (admission.diagnostic) {
        defaultRuntime.log?.(admission.diagnostic.message);
      }
      // Silent suppression: no provider turn, no visible reply. The finally block
      // completes the reply operation and typing, identical to a NO_REPLY turn.
      return returnWithQueuedFollowupDrain(undefined);
    }
  }
  // Adoption transfers the accepted input into ordinary execution custody.
  await admitFollowupRunLifecycle(followupRun);
  const runWithGoalReturn = createGoalContinuationReturn(
    sessionKey &&
      storePath &&
      activeSessionEntry &&
      (activeSessionEntry.agentHarnessId === undefined ||
        activeSessionEntry.agentHarnessId === "openclaw")
      ? {
          base: followupRun,
          initialGoalId:
            activeSessionEntry.goal?.status === "active" ? activeSessionEntry.goal.id : undefined,
          expectedSession: activeSessionEntry,
          sessionKey,
          storePath,
          queueKey: context.queueKey,
          settings: context.resolvedQueue,
          operation: replyOperation,
          runFollowup: runFollowupTurn,
        }
      : undefined,
  );
  const runOutcome = await withBeforeAgentReplyObserver(
    {
      beforeDispatch: async () => {
        replyOperation.abortSignal.throwIfAborted();
        return true;
      },
      afterDispatch: async (hookResult) => {
        if (!hookResult?.handled) {
          return hookResult;
        }
        const hookReply = hookResult.reply ?? {};
        const hookFinalDeliveryText = buildRecoverablePendingFinalDeliveryText([hookReply]);
        const normalizedHookReplies = normalizePendingFinalDeliveryPayloads([hookReply]);
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
                sessionId: replyOperation.sessionId,
                sessionKey,
                storePath,
              },
            });
            await recordPendingDelivery({
              text: hookFinalDeliveryText ?? "",
              intentId: pendingFinalDeliveryIntentId,
              deliveries: [{ id: pendingFinalDeliveryDeliveryId, state: "prepared" }],
              context: resolveReplyRunDeliveryContext({
                ...context,
                sessionKey,
                sessionEntry: activeSessionEntry,
              }),
            });
          }
        }
        activeSessionEntry = getActiveSessionEntry();
        return hookResult;
      },
    },
    () =>
      withCurrentUserTurnInput(followupRun.userTurnTranscriptRecorder, () =>
        traceAgentPhase("reply.run_agent_turn", () =>
          runWithGoalReturn(() =>
            executeAgentTurn({
              ...context,
              opts: executionOpts,
              resolveVisibleReplyDelivery: context.resolveVisibleReplyDelivery,
              replyThreading: replyThreadingOverride ?? sessionCtx.ReplyThreading,
            }),
          ),
        ),
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
    return {};
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
        : {},
    );
  }

  const execution = runOutcome.outcome;
  const result = await runWithGoalReturn(() =>
    finalizeReplyAgentRun({
      ...context,
      opts: executionOpts,
      activeSessionEntry,
      noOpRearmWakeClass,
      preflightCompactionApplied,
      replySessionKey,
      runFollowupTurn,
      execution,
      runId: runOutcome.runId,
      runStartedAt,
    }),
  );
  const { postCompactionModelFailure } = execution;
  if (Array.isArray(result)) {
    return result.map((payload) =>
      markPostCompactionModelFailurePayload(postCompactionModelFailure, payload),
    );
  }
  return result
    ? markPostCompactionModelFailurePayload(postCompactionModelFailure, result)
    : result;
}

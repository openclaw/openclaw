import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type {
  CompactionAccountingFact,
  RunEmbeddedAgentInternalParams,
} from "../../agents/embedded-agent-runner/run/internal-params.js";
import { runEmbeddedAgent } from "../../agents/embedded-agent.js";
import { resolveAgentHarnessPolicy } from "../../agents/harness/policy.js";
import { resolveOpenAIRuntimeProvider } from "../../agents/openai-routing.js";
import type { CompactionRequestBudget } from "../../agents/sessions/compaction/request-budget.js";
import { resolveGroupSessionKey } from "../../config/sessions.js";
import { logVerbose } from "../../globals.js";
import { resolveSessionPinnedHarnessId } from "../../sessions/agent-harness-session-key.js";
import {
  isMarkdownCapableMessageChannel,
  resolveMessageChannel,
} from "../../utils/message-channel.js";
import type { ReplyPayload } from "../types.js";
import { createAgentLifecycleTerminalBackstop } from "./agent-lifecycle-terminal.js";
import { resolveTerminalReplyDelivery } from "./agent-runner-core.js";
import {
  createAgentRunEventHandler,
  type MessageToolDeliveryState,
} from "./agent-runner-event-handler.js";
import type { CompletedAgentAuthSelection } from "./agent-runner-execution.types.js";
import type { AgentFallbackCandidateCommonParams } from "./agent-runner-fallback-cycle.types.js";
import { buildFallbackCandidateTurnParams } from "./agent-runner-run-params.js";
import { buildEmbeddedRunExecutionParams } from "./agent-runner-utils.js";
import type { DirectBlockDelivery } from "./reply-delivery.js";
import { resolveReplyOperationTerminationFields } from "./reply-operation-abort.js";
import { markReplyOperationGlobalLaneWaitProgress } from "./reply-run-registry.js";
import {
  bindSourceReplyDeliveryRuntime,
  readSourceReplyDeliveryRuntime,
} from "./source-reply-delivery-runtime.js";

export async function runEmbeddedFallbackCandidate(
  params: AgentFallbackCandidateCommonParams & {
    candidateAgentRuntime: string;
    effectiveRun: AgentFallbackCandidateCommonParams["candidateRun"];
    directBlockDeliveries: DirectBlockDelivery[];
    getLifecycleGeneration: () => string;
    onLifecycleGeneration: (generation: string) => void;
    notifyUserAboutCompaction: boolean;
    messageToolDeliveryState: MessageToolDeliveryState;
    onCompactionFacts: (facts: {
      accounting?: CompactionAccountingFact;
      postCompactionModelAttempted: boolean;
    }) => void;
  },
): Promise<{
  result: Awaited<ReturnType<typeof runEmbeddedAgent>>;
  maintenanceAuthProfile?: CompletedAgentAuthSelection;
  compactionRequestBudget?: CompactionRequestBudget;
}> {
  const turn = params.turn;
  let maintenanceAuthProfile: CompletedAgentAuthSelection | undefined;
  let compactionRequestBudget: CompactionRequestBudget | undefined;
  const sourceReplyDeliveryRuntime = readSourceReplyDeliveryRuntime(params.candidateRun);
  const candidateRun = {
    ...params.candidateRun,
    ...params.candidateFastMode,
    thinkLevel: params.candidateThinkLevel,
  };
  const { embeddedContext, senderContext, runBaseParams } = await buildEmbeddedRunExecutionParams({
    run: candidateRun,
    replyRoute: turn.followupRun,
    sessionCtx: turn.sessionCtx,
    hasRepliedRef: turn.opts?.hasRepliedRef,
    provider: params.provider,
    runId: params.runId,
    promptCacheKey: turn.opts?.promptCacheKey,
    allowTransientCooldownProbe: params.allowTransientCooldownProbe,
    model: params.model,
    agentRuntime: params.candidateAgentRuntime,
  });
  if (sourceReplyDeliveryRuntime) {
    bindSourceReplyDeliveryRuntime(runBaseParams, sourceReplyDeliveryRuntime);
  }
  const agentHarnessPolicy = params.agentHarnessRuntimeOverride
    ? ({ runtime: params.agentHarnessRuntimeOverride, runtimeSource: "model" } as const)
    : resolveAgentHarnessPolicy({
        provider: params.provider,
        modelId: params.model,
        config: params.runtimeConfig,
        agentId: turn.followupRun.run.agentId,
        sessionKey: turn.followupRun.run.runtimePolicySessionKey ?? turn.sessionKey,
      });
  const embeddedRunProvider = resolveOpenAIRuntimeProvider({
    provider: params.provider,
    harnessRuntime: agentHarnessPolicy.runtime,
    authProfileProvider: runBaseParams.authProfileId?.split(":", 1)[0],
    authProfileId: runBaseParams.authProfileId,
    config: params.runtimeConfig,
    workspaceDir: turn.followupRun.run.workspaceDir,
  });
  const embeddedRunHarnessOverride =
    params.agentHarnessRuntimeOverride ??
    (agentHarnessPolicy.runtime === "openclaw" && embeddedRunProvider !== params.provider
      ? "openclaw"
      : undefined);
  let attemptCompactionCount = 0;
  let postCompactionModelAttempted = false;
  let compactionAccounting: CompactionAccountingFact | undefined;
  const lifecycleBackstop = createAgentLifecycleTerminalBackstop({
    runId: params.runId,
    sessionKey: turn.sessionKey,
    getLifecycleGeneration: params.getLifecycleGeneration,
    resolveTerminationFields: (error) =>
      resolveReplyOperationTerminationFields(error, params.runAbortSignal, turn.replyOperation),
  });
  params.onLifecycleBackstop(lifecycleBackstop);
  try {
    // Profiler milestone. Exposes pre-dispatch delay without normal-path logging.
    params.timing.logMilestoneIfSlow({
      runId: params.runId,
      sessionId: turn.followupRun.run.sessionId,
      sessionKey: turn.sessionKey,
      milestone: "before_embedded_run",
    });
    let eventHandler: ReturnType<typeof createAgentRunEventHandler> | undefined;
    const result = await params.timing.measure("embedded_run", () => {
      const embeddedRunParams: RunEmbeddedAgentInternalParams = {
        ...embeddedContext,
        lifecycleGeneration: params.getLifecycleGeneration(),
        allowGatewaySubagentBinding: true,
        cronCreatorAuthorityCapability: turn.opts?.cronCreatorAuthorityCapability,
        cronCreatorAuthorityUnavailableReason:
          turn.opts?.turnAdoptionLifecycle?.cronCreatorAuthorityUnavailable,
        groupId: resolveGroupSessionKey(turn.sessionCtx)?.id,
        groupChannel:
          normalizeOptionalString(turn.sessionCtx.GroupChannel) ??
          normalizeOptionalString(turn.sessionCtx.GroupSubject),
        groupSpace: normalizeOptionalString(turn.sessionCtx.GroupSpace),
        ...senderContext,
        ...runBaseParams,
        ...buildFallbackCandidateTurnParams(params),
        contextWindow: turn.getActiveSessionEntry()?.contextWindow,
        provider: embeddedRunProvider,
        agentHarnessId: resolveSessionPinnedHarnessId(turn.getActiveSessionEntry()),
        agentHarnessRuntimeOverride: embeddedRunHarnessOverride,
        agentHarnessRuntimePreparationHint:
          agentHarnessPolicy.runtimeSource !== "implicit" ? agentHarnessPolicy.runtime : undefined,
        sandboxSessionKey: turn.runtimePolicySessionKey,
        explicitSkillSelections: turn.followupRun.explicitSkillSelections,
        forceMessageTool: turn.followupRun.run.sourceReplyDeliveryMode === "message_tool_only",
        // requireExplicitMessageTarget for heartbeat turns is already applied by
        // buildFallbackCandidateTurnParams above; heartbeat one-shot embedded runs
        // also force bundle-MCP cleanup and run as a single shot so an isolated
        // heartbeat run can't leak a child process until Gateway restart.
        ...(turn.isHeartbeat ? { cleanupBundleMcpOnRunEnd: true, oneShotCliRun: true } : {}),
        suppressTranscriptOnlyAssistantPersistence:
          turn.followupRun.run.suppressTranscriptOnlyAssistantPersistence,
        assistantErrorTranscript: params.assistantErrorTranscript,
        authProfileFailurePolicy: params.authProfileFailurePolicy,
        onAutoCompactionSucceeded: (count) => {
          attemptCompactionCount = Math.max(attemptCompactionCount, count);
        },
        toolResultFormat: (() => {
          const channel = resolveMessageChannel(turn.sessionCtx.Surface, turn.sessionCtx.Provider);
          return !channel || isMarkdownCapableMessageChannel(channel) ? "markdown" : "plain";
        })(),
        toolProgressDetail: turn.toolProgressDetail,
        // Marks reply-owned policy; final attempt preparation binds its concrete route.
        toolAuthorityFingerprint: turn.replyOperation?.toolAuthorityFingerprint,
        enableHeartbeatTool: turn.opts?.enableHeartbeatTool,
        forceHeartbeatTool: turn.opts?.forceHeartbeatTool,
        deferTerminalLifecycle: true,
        onAttemptStart: lifecycleBackstop.beginAttempt,
        onCompactionAccounting: (fact) => {
          compactionAccounting = fact;
        },
        onCompactionRequestBudget: (budget) => {
          compactionRequestBudget = budget;
        },
        onDeferredLifecycleOwner: params.deferredLifecycle.adopt,
        onDeferredLifecycleAbort: params.deferredLifecycle.abort,
        onRetryWait: params.deferredLifecycle.beginRetryWait,
        onExecutionStarted: async (info) => {
          if (info?.lifecycleGeneration) {
            params.onLifecycleGeneration(info.lifecycleGeneration);
          }
          if (agentHarnessPolicy.runtime !== "openclaw" || info?.backend === "cloud-worker") {
            await params.prepareAgentRunStart();
          }
        },
        onExecutionPhase: (info) => {
          if (info.phase === "model_call_started" && attemptCompactionCount > 0) {
            postCompactionModelAttempted = true;
          }
          params.signalExecutionPhaseForTyping(info);
        },
        onLaneWait: ({ waiting }) => {
          const replyOperation = turn.replyOperation;
          if (waiting && replyOperation) {
            markReplyOperationGlobalLaneWaitProgress(replyOperation);
          }
        },
        blockReplyBreak: turn.resolvedBlockStreamingBreak,
        blockReplyChunking: turn.blockReplyChunking,
        // Subscriber callbacks are detached. Stage channel presentation before typing I/O.
        onPartialReply: (payload) => params.presentation.presentPartialReply(payload, "embedded"),
        onAssistantMessageStart: async () => {
          await params.presentation.presentWithTyping(turn.typingSignals.signalMessageStart(), () =>
            turn.opts?.onAssistantMessageStart?.(),
          );
        },
        onReasoningStream:
          turn.typingSignals.shouldStartOnReasoning || turn.opts?.onReasoningStream
            ? async (payload) => {
                if (turn.followupRun.run.silentExpected) {
                  return;
                }
                await params.presentation.presentWithTyping(
                  turn.typingSignals.signalReasoningDelta(),
                  () =>
                    turn.opts?.onReasoningStream?.({
                      text: payload.text,
                      mediaUrls: payload.mediaUrls,
                      isReasoningSnapshot: payload.isReasoningSnapshot,
                      requiresReasoningProgressOptIn: payload.requiresReasoningProgressOptIn,
                    }),
                );
              }
            : undefined,
        streamReasoningInNonStreamModes: turn.opts?.streamReasoningInNonStreamModes,
        onReasoningEnd: turn.opts?.onReasoningEnd
          ? async () => {
              await turn.opts?.onReasoningEnd?.();
            }
          : undefined,
        onAgentEvent: (event) => {
          eventHandler ??= createAgentRunEventHandler({
            turn,
            lifecycleBackstop,
            prepareAgentRunStart: params.prepareAgentRunStart,
            notifyAgentRunStart: params.notifyAgentRunStart,
            sourceRepliesAreToolOnly:
              (sourceReplyDeliveryRuntime?.currentMode ??
                turn.followupRun.run.sourceReplyDeliveryMode) === "message_tool_only",
            messageToolDeliveryState: params.messageToolDeliveryState,
            provider: params.provider,
            model: params.model,
            effectiveSessionId: params.effectiveRun.sessionId,
            notifyUserAboutCompaction: params.notifyUserAboutCompaction,
            onCompactionCompleted: () => {
              attemptCompactionCount += 1;
              return attemptCompactionCount;
            },
          });
          return eventHandler(event);
        },
        // Flush-before-tool requires a handler even when regular block streaming is off.
        onBlockReply: params.presentation.blockReplyHandler,
        resolveReplyDelivery: (minimumAssistantMessageIndex) =>
          resolveTerminalReplyDelivery({
            blockReplyPipeline: turn.blockReplyPipeline,
            directBlockDeliveries: params.directBlockDeliveries,
            minimumAssistantMessageIndex,
            resolveReplyDelivery: turn.opts?.resolveReplyDelivery,
          }),
        onBlockReplyFlush:
          turn.blockStreamingEnabled && turn.blockReplyPipeline
            ? async () => {
                await turn.blockReplyPipeline?.flush({ force: true });
              }
            : undefined,
        shouldEmitToolResult: turn.shouldEmitToolResult,
        shouldEmitToolOutput: turn.shouldEmitToolOutput,
        onToolResult: turn.opts?.onToolResult
          ? (() => {
              // Serialized delivery preserves tool result order across detached callbacks.
              let toolResultChain: Promise<void> = Promise.resolve();
              return (payload: ReplyPayload) => {
                const delivery = toolResultChain.then(async () => {
                  turn.replyOperation?.recordActivity();
                  const { text, skip } = params.presentation.normalizeStreamingText(payload);
                  if (skip) {
                    return;
                  }
                  if (text !== undefined) {
                    await turn.typingSignals.signalTextDelta(text);
                  }
                  await turn.opts?.onToolResult?.({ ...payload, text });
                });
                // Keep later results best-effort while exposing this delivery to awaiting owners.
                toolResultChain = delivery.catch((err: unknown) => {
                  logVerbose(`tool result delivery failed: ${String(err)}`);
                });
                const task = toolResultChain.finally(() => {
                  turn.pendingToolTasks.delete(task);
                });
                turn.pendingToolTasks.add(task);
                return delivery;
              };
            })()
          : undefined,
      };
      embeddedRunParams.onSuccessfulAuthProfile = (profileId) => {
        maintenanceAuthProfile = {
          authProfileId: profileId,
          authProfileIdSource: profileId
            ? profileId === runBaseParams.authProfileId
              ? runBaseParams.authProfileIdSource
              : "auto"
            : undefined,
        };
      };
      return runEmbeddedAgent(embeddedRunParams);
    });
    const resultCompactionCount = Math.max(0, result.meta?.agentMeta?.compactionCount ?? 0);
    attemptCompactionCount = Math.max(attemptCompactionCount, resultCompactionCount);
    return {
      result,
      maintenanceAuthProfile,
      compactionRequestBudget,
    };
  } finally {
    // Runtime event/result counts are observable, but cannot prove a durable write target.
    const accounting: CompactionAccountingFact | undefined =
      compactionAccounting ??
      (attemptCompactionCount > 0
        ? {
            kind: "presentation-only",
            count: attemptCompactionCount,
            currentContextSnapshot: { tokens: undefined },
          }
        : undefined);
    params.onCompactionFacts({ accounting, postCompactionModelAttempted });
  }
}

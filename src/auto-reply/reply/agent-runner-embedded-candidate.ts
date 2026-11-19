import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { parseCompactionDetails } from "../../../packages/agent-core/src/harness/compaction/compaction-details.js";
import type {
  CompactionAccountingFact,
  RunEmbeddedAgentInternalParams,
} from "../../agents/embedded-agent-runner/run/internal-params.js";
import { runEmbeddedAgent } from "../../agents/embedded-agent.js";
import { resolveAgentHarnessPolicy } from "../../agents/harness/policy.js";
import type { ReplyDeliveryState } from "../../agents/reply-completion.js";
import type { CompactionRequestBudget } from "../../agents/sessions/compaction/preparation.types.js";
import type { ContinueWorkRequest } from "../../agents/tools/continue-work-tool.js";
import { resolveGroupSessionKey } from "../../config/sessions.js";
import { readSessionEntryInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import { logVerbose } from "../../globals.js";
import { resolveSessionPinnedHarnessId } from "../../sessions/agent-harness-session-key.js";
import { markReplyOperationGlobalLaneWaitProgress } from "../../sessions/session-controller.js";
import { sanitizeAssistantVisibleTextWithProfile } from "../../shared/text/assistant-visible-text.js";
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
import { runMemoryFlushIfNeeded } from "./agent-runner-memory.js";
import {
  computeRequestCompactionContextUsage,
  releaseQueuedCompactionTolerant,
} from "./agent-runner-post-compaction-release.js";
import { buildFallbackCandidateTurnParams } from "./agent-runner-run-params.js";
import { buildEmbeddedRunExecutionParams } from "./agent-runner-utils.js";
import type { DirectBlockDelivery } from "./reply-delivery.js";
import { resolveReplyOperationTerminationFields } from "./reply-operation-abort.js";
import { resolveOperationalRunCompactionCount } from "./run-compaction-count.js";
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
  continueWorkRequests: ContinueWorkRequest[];
  compactionTraceparent?: string;
  rawContinuationText?: string;
}> {
  const turn = params.turn;
  const resolveReplyDeliveryFacts: NonNullable<
    RunEmbeddedAgentInternalParams["resolveReplyDeliveryFacts"]
  > = async (minimumAssistantMessageIndex) => {
    let source: ReplyDeliveryState = "pending";
    const terminal = await resolveTerminalReplyDelivery({
      blockReplyPipeline: turn.blockReplyPipeline,
      directBlockDeliveries: params.directBlockDeliveries,
      minimumAssistantMessageIndex,
      resolveReplyDelivery: async (minimum) => {
        const facts = await turn.opts?.resolveReplyDeliveryFacts?.(minimum);
        if (facts) {
          source = facts.source;
          return facts.terminal;
        }
        source = (await turn.opts?.resolveReplyDelivery?.(minimum)) ?? "missing";
        return source;
      },
    });
    return { source, terminal };
  };
  let maintenanceAuthProfile: CompletedAgentAuthSelection | undefined;
  let compactionRequestBudget: CompactionRequestBudget | undefined;
  const sourceReplyDeliveryRuntime = readSourceReplyDeliveryRuntime(params.candidateRun);
  const candidateRun = {
    ...params.candidateRun,
    ...params.candidateFastMode,
    thinkLevel: params.candidateThinkLevel,
  };
  const runBaseParams = await buildEmbeddedRunExecutionParams({
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
  let attemptCompactionCount = 0;
  const attemptContinueWorkRequests: ContinueWorkRequest[] = [];
  let attemptCompactionTraceparent: string | undefined;
  const continuationEnabled = params.runtimeConfig.agents?.defaults?.continuation?.enabled === true;
  let postCompactionModelAttempted = false;
  let compactionAccounting: CompactionAccountingFact | undefined;
  const lifecycleBackstop = createAgentLifecycleTerminalBackstop({
    runId: params.runId,
    sessionKey: turn.sessionKey,
    isContinuationWake: turn.isContinuationWake,
    onTerminalEvent: turn.followupRun.run.internalEventExecution?.onTerminalEvent,
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
        ...runBaseParams,
        beforeRecoveryCompaction: async (recovery) => {
          if (turn.recoveryMemoryFlushAttempted) {
            return "skipped: already attempted this turn";
          }
          turn.recoveryMemoryFlushAttempted = true;
          const entry =
            turn.sessionKey && turn.storePath
              ? await readSessionEntryInWorker({
                  storePath: turn.storePath,
                  sessionKey: turn.sessionKey,
                })
              : turn.getActiveSessionEntry();
          if (entry?.sessionId !== recovery.sessionId) {
            return "skipped: source session changed";
          }
          const flushed = await runMemoryFlushIfNeeded({
            cfg: params.runtimeConfig,
            followupRun: {
              ...turn.followupRun,
              abortSignal: params.runAbortSignal ?? turn.followupRun.abortSignal,
              run: { ...candidateRun, ...recovery },
            },
            recoveryContextTokenBudget: recovery.contextTokenBudget,
            defaultModel: recovery.model,
            resolvedVerboseLevel: turn.resolvedVerboseLevel,
            sessionEntry: entry,
            sessionStore: turn.activeSessionStore,
            sessionKey: turn.sessionKey,
            runtimePolicySessionKey: turn.runtimePolicySessionKey,
            storePath: turn.storePath,
            replyOperation: turn.replyOperation,
            abortSignal: params.runAbortSignal,
            opts: { runId: params.runId },
          });
          return flushed.outcome;
        },
        ...params.scheduledInference?.runParams(params.provider),
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
        ...buildFallbackCandidateTurnParams(params),
        contextWindow: turn.getActiveSessionEntry()?.contextWindow,
        sessionPromptDelivery: turn.getActiveSessionEntry()?.delivery,
        provider: params.provider,
        agentHarnessId: resolveSessionPinnedHarnessId(turn.getActiveSessionEntry()),
        agentHarnessRuntimeOverride: params.agentHarnessRuntimeOverride,
        agentHarnessRuntimePreparationHint:
          agentHarnessPolicy.runtimeSource !== "implicit" ? agentHarnessPolicy.runtime : undefined,
        sandboxSessionKey: turn.runtimePolicySessionKey,
        explicitSkillSelections: turn.followupRun.explicitSkillSelections,
        forceMessageTool:
          turn.followupRun.run.scheduledAutomation?.sourceDelivery?.messageTool.force ??
          turn.followupRun.run.sourceReplyDeliveryMode === "message_tool_only",
        ...(turn.followupRun.run.scheduledAutomation
          ? {
              disableMessageTool:
                turn.followupRun.run.scheduledAutomation.sourceDelivery?.messageTool.enabled ===
                false,
            }
          : {}),
        suppressTranscriptOnlyAssistantPersistence:
          turn.followupRun.run.suppressTranscriptOnlyAssistantPersistence,
        assistantErrorTranscript: params.assistantErrorTranscript,
        authProfileFailurePolicy: params.authProfileFailurePolicy,
        drainsContinuationDelegateQueue: turn.followupRun.run.drainsContinuationDelegateQueue,
        continueWorkOpts: continuationEnabled
          ? {
              requestContinuation: (request) => {
                attemptContinueWorkRequests.push(request);
              },
            }
          : undefined,
        requestCompactionOpts: continuationEnabled
          ? {
              sessionId: turn.followupRun.run.sessionId,
              ownerAgentId: turn.followupRun.run.agentId,
              contextUsageOrigin: "live_runner" as const,
              getContextUsage: () =>
                computeRequestCompactionContextUsage({
                  entry: turn.getActiveSessionEntry(),
                  cfg: params.runtimeConfig,
                  provider: params.provider,
                  model: params.model,
                }),
              triggerCompaction: async (request) => {
                attemptCompactionTraceparent = request.traceparent;
                const operatorAuthority = turn.followupRun.operatorAuthority;
                const assertCompactionSourceActive = () => {
                  params.runAbortSignal?.throwIfAborted();
                  operatorAuthority?.assertCurrent();
                };
                try {
                  const { compactQueuedEmbeddedAgentSession: compactEmbeddedAgentSession } =
                    await import("../../agents/embedded-agent-runner/compact.queued.js");
                  const compactionResult = await compactEmbeddedAgentSession(
                    {
                      sessionId: turn.followupRun.run.sessionId ?? "",
                      runId: request.runId ?? params.runId,
                      sessionKey: turn.sessionKey,
                      sessionFile: turn.followupRun.run.sessionFile ?? "",
                      workspaceDir: turn.followupRun.run.workspaceDir ?? process.cwd(),
                      config: params.runtimeConfig,
                      messageProvider: runBaseParams.messageProvider,
                      provider: params.provider,
                      model: params.model,
                      authProfileId: runBaseParams.authProfileId,
                      customInstructions: request.customInstructions,
                      trigger: request.trigger,
                      diagId: request.diagId,
                      traceparent: request.traceparent,
                    },
                    {
                      // The requesting turn's own admission is the compaction source.
                      assertActive: assertCompactionSourceActive,
                      sourceAuthority: {
                        assertActive: assertCompactionSourceActive,
                        operatorAuthority,
                      },
                    },
                  );
                  if (compactionResult.ok && compactionResult.compacted) {
                    await releaseQueuedCompactionTolerant({
                      activeSessionStore: turn.activeSessionStore,
                      compactionResult,
                      followupRun: turn.followupRun,
                      getActiveSessionEntry: turn.getActiveSessionEntry,
                      sessionKey: turn.sessionKey,
                      storePath: turn.storePath,
                      traceparent: request.traceparent,
                    });
                  }
                  return {
                    ok: compactionResult.ok,
                    compacted: compactionResult.compacted,
                    reason: compactionResult.reason,
                    ...(parseCompactionDetails(compactionResult.result?.details)?.qualityDegraded
                      ? { qualityDegraded: true }
                      : {}),
                  };
                } catch (error) {
                  return {
                    ok: false,
                    compacted: false,
                    reason: error instanceof Error ? error.message : String(error),
                  };
                }
              },
            }
          : undefined,
        ...(params.cyberAccessProgram
          ? {
              cyberAccessProgram: params.cyberAccessProgram,
              ...(params.authProfileId
                ? { authProfileId: params.authProfileId, authProfileIdSource: "user" as const }
                : {}),
            }
          : {}),
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
        deferTerminalLifecycle: true,
        onAttemptStart: lifecycleBackstop.beginAttempt,
        onAttemptTerminalReplaced: lifecycleBackstop.replaceAttemptTerminal,
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
          if (turn.followupRun.run.scheduledAutomation) {
            await params.notifyScheduledExecutionStarted(
              lifecycleBackstop,
              () => turn.sessionKey ?? turn.followupRun.run.sessionKey,
            );
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
          turn.followupRun.run.scheduledAutomation?.onLaneWait?.({ waiting: waiting !== false });
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
        resolveReplyDelivery: async (minimumAssistantMessageIndex) =>
          (await resolveReplyDeliveryFacts(minimumAssistantMessageIndex)).terminal,
        resolveReplyDeliveryFacts,
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
        const scheduled = params.scheduledInference?.runParams(params.provider);
        if (scheduled && "onSuccessfulAuthProfile" in scheduled) {
          scheduled.onSuccessfulAuthProfile?.(profileId);
        }
        maintenanceAuthProfile = {
          authProfileId: profileId,
          authProfileIdSource: profileId
            ? profileId === embeddedRunParams.authProfileId
              ? embeddedRunParams.authProfileIdSource
              : "auto"
            : undefined,
        };
      };
      params.scheduledInference?.assertCandidate(params.provider, false);
      return runEmbeddedAgent(embeddedRunParams);
    });
    const resultCompactionCount = resolveOperationalRunCompactionCount(result.meta);
    attemptCompactionCount = Math.max(attemptCompactionCount, resultCompactionCount);
    return {
      result,
      maintenanceAuthProfile,
      compactionRequestBudget,
      continueWorkRequests: attemptContinueWorkRequests,
      compactionTraceparent: attemptCompactionTraceparent,
      ...(!(result.meta?.error?.kind === "incomplete_turn" && result.meta.replayInvalid === true) &&
      result.meta?.finalAssistantRawText
        ? {
            rawContinuationText: normalizeOptionalString(
              sanitizeAssistantVisibleTextWithProfile(
                result.meta.finalAssistantRawText,
                "final-answer-delivery",
              ),
            ),
          }
        : {}),
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

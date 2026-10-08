import {
  cliBackendAcceptsAuthProfileForwarding,
  resolveCliExecutionAuthProfileId,
} from "../../agents/cli-execution-auth.js";
import { buildCliMcpDelegationCapabilityBinding } from "../../agents/cli-runner/mcp-grant-context.js";
import {
  buildCliSessionForkRunParams,
  clearCliSessionInStore,
  settleCliSessionResult,
} from "../../agents/cli-session-store.js";
import { shouldClearFailedCliSessionBinding } from "../../agents/cli-session.js";
import { resolveDelegationCapability } from "../../agents/delegation-capability.js";
import { withAdmittedCliCandidate } from "../../agents/embedded-agent-runner/run-entry-cli.js";
import {
  getGeneratedMediaTaskIdsForSessionKey,
  hasNewGeneratedMediaTaskForSessionKey,
} from "../../agents/media-generation-activity.js";
import { findModelInCatalog } from "../../agents/model-catalog-lookup.js";
import { normalizeChatType } from "../../channels/chat-type.js";
import { shouldPreserveUserFacingSessionStateForInputProvenance } from "../../sessions/input-provenance.js";
import { createAgentLifecycleTerminalBackstop } from "./agent-lifecycle-terminal.js";
import { resolveRunAuthProfile } from "./agent-runner-auth-profile.js";
import {
  createCliReasoningStreamBridge,
  createCliToolSummaryTracker,
  keepCliSessionBindingOnlyWhenReused,
  runCliAgentWithLifecycle,
} from "./agent-runner-cli-dispatch.js";
import { buildCommandOutputFromToolResultEvent } from "./agent-runner-command-output.js";
import type { AgentFallbackCandidateCommonParams } from "./agent-runner-fallback-cycle.types.js";
import { deliverPreparedBlockReply } from "./agent-runner-presentation.js";
import {
  buildFallbackCandidateTurnParams,
  buildReplyRunStateParams,
  resolveRunModelHasVision,
} from "./agent-runner-run-params.js";
import { buildReplyRouteThreadingToolContext } from "./agent-runner-utils.js";
import { prepareCliReplyPayload } from "./cli-reply-payload.js";
import { shouldBridgeCliPreambleEvents } from "./get-reply.types.js";
import { hasInboundAudio } from "./inbound-media.js";
import { resolveOriginMessageProvider } from "./origin-routing.js";
import { resolveReplyOperationTerminationFields } from "./reply-operation-abort.js";

export async function runCliFallbackCandidate(
  params: AgentFallbackCandidateCommonParams & {
    cliExecutionProvider: string;
    lifecycleGeneration: string;
  },
): ReturnType<typeof runCliAgentWithLifecycle> {
  const turn = params.turn;
  const onPreparedBlockReply = turn.opts?.onPreparedBlockReply;
  const onNativeBlockReply: NonNullable<typeof turn.opts>["onBlockReply"] =
    turn.opts?.onBlockReply ??
    (onPreparedBlockReply
      ? (payload, context) => deliverPreparedBlockReply({ onPreparedBlockReply }, payload, context)
      : undefined);
  const expectedLifecycleRevision = turn.getActiveSessionEntry()?.lifecycleRevision;
  const selectedModelEntry = findModelInCatalog(
    params.candidateRun.thinkingCatalog ?? [],
    params.provider,
    params.model,
  );
  const modelHasVision = await resolveRunModelHasVision({
    run: params.candidateRun,
    provider: params.provider,
    model: params.model,
  });
  const sessionKey = turn.sessionKey ?? turn.followupRun.run.sessionKey;
  const sessionTarget =
    sessionKey && turn.storePath
      ? {
          agentId: turn.followupRun.run.agentId,
          sessionId: turn.followupRun.run.sessionId,
          sessionKey,
          storePath: turn.storePath,
        }
      : undefined;
  const cliLifecycleStartedAt = Date.now();
  const lifecycleBackstop = createAgentLifecycleTerminalBackstop({
    runId: params.runId,
    sessionKey: turn.sessionKey,
    startedAt: cliLifecycleStartedAt,
    getLifecycleGeneration: () => params.lifecycleGeneration,
    resolveTerminationFields: (error) =>
      resolveReplyOperationTerminationFields(error, params.runAbortSignal, turn.replyOperation),
  });
  params.onLifecycleBackstop(lifecycleBackstop);
  const allowCliAuthProfileForwarding = cliBackendAcceptsAuthProfileForwarding({
    provider: params.cliExecutionProvider,
    config: params.runtimeConfig,
    agentId: params.candidateRun.agentId,
  });
  const hookMessageProvider = resolveOriginMessageProvider({
    originatingChannel: turn.followupRun.originatingChannel,
    provider: turn.sessionCtx.Provider,
  });
  // Thread-originated turns take the channel adapter's thread target and reply
  // mode, as on the embedded path. A configured replyToMode "off" would otherwise
  // post untargeted message-tool sends at the channel root.
  const cliThreadingContext = buildReplyRouteThreadingToolContext({
    run: params.candidateRun,
    replyRoute: turn.followupRun,
    sessionCtx: turn.sessionCtx,
    hasRepliedRef: turn.opts?.hasRepliedRef,
  });
  const cliThreadRequired = cliThreadingContext.sameChannelThreadRequired === true;
  const cliCurrentThreadId = cliThreadRequired
    ? cliThreadingContext.currentThreadTs
    : (turn.followupRun.originatingThreadId ?? turn.sessionCtx.MessageThreadId);
  const cliReplyToMode = cliThreadRequired
    ? cliThreadingContext.replyToMode
    : (turn.followupRun.originatingReplyToMode ?? turn.sessionCtx.ReplyToMode);
  const cliCurrentMessageId =
    cliThreadingContext.currentMessageId != null
      ? String(cliThreadingContext.currentMessageId)
      : undefined;
  const commandDetailsVisible = turn.resolvedVerboseLevel === "full";
  const cliToolSummaryTracker = createCliToolSummaryTracker({
    detailMode: turn.toolProgressDetail,
    commandDetailsVisible,
    shouldEmitToolResult: turn.shouldEmitToolResult,
    shouldEmitToolOutput: turn.shouldEmitToolOutput,
    deliver: (payload) => turn.opts?.onToolResult?.(payload),
  });
  // CLI backends report a tool's outcome on the result event and never repeat it,
  // so the terminal fact has to be projected here. The embedded path gets this
  // from the shared agent-event handler; without it a failed CLI command renders
  // exactly like one that succeeded.
  const deliverCliCommandOutcome = async (
    payload: Parameters<typeof cliToolSummaryTracker.noteToolEvent>[0],
    commandBearing: boolean,
  ) => {
    const onCommandOutput = turn.opts?.onCommandOutput;
    if (!onCommandOutput) {
      return;
    }
    const commandOutput = buildCommandOutputFromToolResultEvent({
      stream: "tool",
      data: { ...payload, commandBearing },
    });
    if (commandOutput) {
      await onCommandOutput(commandOutput);
    }
  };
  const bridgeCliPreambleProgress =
    Boolean(turn.opts?.onItemEvent) && shouldBridgeCliPreambleEvents(turn.opts);
  const bridgeCliDurableCommentary =
    Boolean(params.presentation.blockReplyHandler) &&
    (turn.blockStreamingEnabled || turn.opts?.commentaryPayloadsEnabled === true);
  const toolAuthorityRoute = { provider: params.provider, model: params.model };
  const toolAuthorityFingerprint =
    await turn.replyOperation?.bindToolAuthorityRouteAsync(toolAuthorityRoute);
  return params.timing.measure("cli_run", () =>
    withAdmittedCliCandidate(
      {
        claim: {
          sessionId: turn.followupRun.run.sessionId,
          sessionKey,
          agentId: turn.followupRun.run.agentId,
          runId: params.runId,
        },
        admission: {
          preparedRunAdmission: params.preparedRunAdmission,
          lifecycleGeneration: params.lifecycleGeneration,
          isFinalFallbackAttempt: params.isFinalFallbackAttempt,
          abortSignal: params.runAbortSignal,
          trigger: turn.isHeartbeat ? "heartbeat" : "user",
          inputProvenance: turn.followupRun.run.inputProvenance,
        },
        provider: params.cliExecutionProvider,
        sessionTarget,
        expectedLifecycleRevision,
        readMode: "read-only",
        getSessionEntry: () => turn.getActiveSessionEntry(),
        classifyResult: params.classifyResult,
      },
      async ({
        sessionEntry: initialSessionEntry,
        cliSessionBinding,
        assertSettlementCurrent,
        settleResult,
      }) => {
        let sessionEntry = initialSessionEntry;
        const clearCliBinding = () =>
          clearCliSessionInStore({
            agentId: turn.followupRun.run.agentId,
            provider: params.cliExecutionProvider,
            expectedCliSessionId: cliSessionBinding?.sessionId,
            expectedSessionId: sessionEntry?.sessionId,
            assertCommitAllowed: assertSettlementCurrent,
            sessionKey: turn.sessionKey,
            sessionStore: turn.activeSessionStore,
            storePath: turn.storePath,
            activeSessionEntry: sessionEntry,
          });
        // The CLI owner must see explicit pins before provider scoping can discard them.
        const authProfileId = allowCliAuthProfileForwarding
          ? resolveCliExecutionAuthProfileId({
              cliExecutionProvider: params.cliExecutionProvider,
              authProfileProvider: params.provider,
              config: params.runtimeConfig,
              agentDir: params.candidateRun.agentDir,
              selected: params.candidateRun,
              sessionBinding: cliSessionBinding,
            })
          : resolveRunAuthProfile(params.candidateRun, params.cliExecutionProvider, {
              config: params.runtimeConfig,
            }).authProfileId;
        const diagnosticOwner = params.deferredLifecycle.handoffToCli();
        // A forked child carries the parent's binding with a one-shot fork marker;
        // honor it here or the child resumes inside the parent's native thread.
        const forkCliSessionOnResume = cliSessionBinding?.forkNextResume === true;
        const forkRunParams =
          cliSessionBinding?.sessionId && sessionKey && turn.activeSessionStore && turn.storePath
            ? buildCliSessionForkRunParams(
                {
                  agentId: turn.followupRun.run.agentId,
                  provider: params.cliExecutionProvider,
                  expectedCliSessionId: cliSessionBinding.sessionId,
                  sessionKey,
                  sessionStore: turn.activeSessionStore,
                  storePath: turn.storePath,
                  assertCommitAllowed: assertSettlementCurrent,
                  abortSignal: params.runAbortSignal,
                },
                (entry) => {
                  sessionEntry = entry;
                },
              )
            : undefined;
        const mediaTaskIdsBefore = getGeneratedMediaTaskIdsForSessionKey(
          turn.sessionKey,
          turn.followupRun.run.agentId,
        );
        let droppedCliSessionReplacement = false;
        await params.prepareAgentRunStart();
        assertSettlementCurrent();
        const candidateResult = await runCliAgentWithLifecycle({
          runId: params.runId,
          lifecycleGeneration: params.lifecycleGeneration,
          startedAt: cliLifecycleStartedAt,
          onAgentRunStart: params.notifyAgentRunStart,
          suppressAssistantBridge: turn.followupRun.run.silentExpected,
          onActivity: () => turn.replyOperation?.recordActivity(),
          onErrorBeforeLifecycle:
            params.cliExecutionProvider === "claude-cli" && cliSessionBinding?.sessionId
              ? async (error) => {
                  if (
                    !shouldClearFailedCliSessionBinding({
                      error,
                      binding: cliSessionBinding,
                      hasNewGeneratedMediaTask: hasNewGeneratedMediaTaskForSessionKey(
                        turn.sessionKey,
                        mediaTaskIdsBefore,
                        turn.followupRun.run.agentId,
                      ),
                    })
                  ) {
                    return;
                  }
                  await clearCliBinding();
                }
              : undefined,
          preserveProgressCallbackStartOrder: params.preserveProgressCallbackStartOrder,
          onAssistantText: (text) => params.presentation.presentPartialReply({ text }, "cli"),
          onCompletedReply: async (text, assistantMessageIndex) => {
            params.runAbortSignal?.throwIfAborted();
            assertSettlementCurrent();
            const reply = prepareCliReplyPayload(text, cliCurrentMessageId, assistantMessageIndex);
            await params.presentation.blockReplyHandler?.(reply, { completed: true });
          },
          onReasoningText: createCliReasoningStreamBridge(turn.opts?.onReasoningStream),
          onPlanUpdate: turn.opts?.onPlanUpdate,
          onReasoningProgress: (payload) => turn.opts?.onReasoningProgress?.(payload),
          onCompactionStart: turn.opts?.onCompactionStart,
          onCompactionEnd: turn.opts?.onCompactionEnd,
          onToolEvent: async (payload) => {
            const summaryPromise = cliToolSummaryTracker.noteToolEvent(payload);
            if (payload.phase === "result") {
              await deliverCliCommandOutcome(payload, await summaryPromise);
              return;
            }
            const { name, phase, args, toolCallId } = payload;
            const deliverToolStart = () =>
              turn.opts?.onToolStart?.({
                ...(toolCallId ? { toolCallId } : {}),
                name,
                phase,
                args,
                detailMode: turn.toolProgressDetail,
              });
            if (!params.preserveProgressCallbackStartOrder) {
              await summaryPromise;
              await Promise.all([turn.typingSignals.signalToolStart(), deliverToolStart()]);
              return;
            }
            // Tool and assistant bridges drain independently. Preserve source order.
            await Promise.all([
              summaryPromise,
              params.presentation.presentWithTyping(
                turn.typingSignals.signalToolStart(),
                async () => {
                  await deliverToolStart();
                },
              ),
            ]);
          },
          onItemEvent: turn.opts?.onItemEvent,
          onCommentaryText:
            bridgeCliPreambleProgress || bridgeCliDurableCommentary
              ? async (payload) => {
                  const deliveries: unknown[] = [];
                  if (bridgeCliPreambleProgress) {
                    deliveries.push(
                      turn.opts?.onItemEvent?.({
                        itemId: payload.itemId,
                        kind: "preamble",
                        progressText: payload.text,
                        // The block bridge owns durability; this event remains a progress preview.
                        ...(bridgeCliDurableCommentary ? { suppressDurableProgress: true } : {}),
                      }),
                    );
                  }
                  if (bridgeCliDurableCommentary) {
                    // Block mode treats completed CLI text as an ordinary answer block so
                    // the existing pipeline owns coalescing and final-payload dedupe.
                    const reply = prepareCliReplyPayload(payload.text, cliCurrentMessageId);
                    if (!turn.blockStreamingEnabled) {
                      reply.isCommentary = true;
                    }
                    deliveries.push(params.presentation.blockReplyHandler?.(reply));
                  }
                  await Promise.all(deliveries);
                }
              : undefined,
          onFastModeAutoProgress: (payload) => turn.opts?.onToolResult?.(payload),
          transformResult:
            turn.followupRun.currentInboundEventKind === "room_event"
              ? (resultLocal) =>
                  keepCliSessionBindingOnlyWhenReused({
                    result: resultLocal,
                    existingSessionId: cliSessionBinding?.sessionId,
                    onDroppedReplacement: () => {
                      droppedCliSessionReplacement = true;
                    },
                  })
              : undefined,
          runParams: {
            ...buildFallbackCandidateTurnParams(params),
            ...buildReplyRunStateParams(turn.followupRun.run),
            diagnosticOwner,
            sessionId: turn.followupRun.run.sessionId,
            sessionKey,
            sessionTarget,
            sessionEntry,
            chatType:
              normalizeChatType(turn.followupRun.originatingChatType) ??
              normalizeChatType(turn.sessionCtx.ChatType) ??
              params.candidateRun.chatType,
            runtimePolicySessionKey:
              turn.followupRun.run.runtimePolicySessionKey ?? turn.runtimePolicySessionKey,
            agentId: turn.followupRun.run.agentId,
            config: params.runtimeConfig,
            persistAssistantTranscript:
              turn.followupRun.currentInboundEventKind !== "room_event" &&
              turn.followupRun.run.suppressTranscriptOnlyAssistantPersistence !== true,
            storePath: turn.storePath,
            // Candidate zero is the primary attempt; later candidates are
            // fallbacks. Carry the runner-owned fact instead of inferring from
            // this shared dispatch path, or primary CLI runs lose delegation.
            ...buildCliMcpDelegationCapabilityBinding(
              resolveDelegationCapability({
                fallbackActive: params.isFallbackRetry,
                inputProvenance: turn.followupRun.run.inputProvenance,
                disableTools: turn.opts?.disableTools,
                toolsAllow: turn.opts?.toolsAllow,
              }),
            ),
            modelProvider: params.provider,
            requesterModel: { provider: params.provider, model: params.model },
            modelHasVision,
            modelContextWindow: selectedModelEntry?.contextWindow,
            modelContextTokens: selectedModelEntry?.contextTokens,
            contextWindow: sessionEntry?.contextWindow,
            provider: params.cliExecutionProvider,
            execOverrides: turn.followupRun.run.execOverrides,
            bashElevated: turn.followupRun.run.bashElevated,
            model: params.model,
            thinkLevel: params.candidateThinkLevel,
            fastMode: params.candidateFastMode.fastMode,
            fastModeAutoOnSeconds: params.candidateFastMode.fastModeAutoOnSeconds,
            timeoutMs: turn.followupRun.run.timeoutMs,
            runTimeoutOverrideMs: turn.followupRun.run.runTimeoutOverrideMs,
            runId: params.runId,
            // requireExplicitMessageTarget for heartbeat turns is already applied by
            // buildFallbackCandidateTurnParams above; heartbeat one-shot CLI runs also
            // force live-session and bundle-MCP cleanup and run as a single shot so an
            // isolated heartbeat run can't leak a child process until Gateway restart.
            ...(turn.isHeartbeat
              ? {
                  cleanupCliLiveSessionOnRunEnd: true,
                  cleanupBundleMcpOnRunEnd: true,
                  oneShotCliRun: true,
                }
              : {}),
            extraSystemPromptStatic: turn.followupRun.run.extraSystemPromptStatic,
            cliSessionBindingFacts: turn.followupRun.run.cliSessionBindingFacts,
            cliSessionId: cliSessionBinding?.sessionId,
            cliSessionBinding,
            forkCliSessionOnResume,
            ...forkRunParams,
            authProfileId,
            mediaImageLayout: params.currentTurnImages.mediaImageLayout,
            messageChannel: turn.followupRun.originatingChannel ?? undefined,
            messageProvider: hookMessageProvider,
            currentChannelId:
              turn.followupRun.originatingTo ?? turn.sessionCtx.OriginatingTo ?? turn.sessionCtx.To,
            senderId: turn.followupRun.run.senderId,
            senderName: turn.followupRun.run.senderName,
            senderUsername: turn.followupRun.run.senderUsername,
            senderE164: turn.followupRun.run.senderE164,
            groupId: turn.followupRun.run.groupId,
            groupChannel: turn.followupRun.run.groupChannel,
            groupSpace: turn.followupRun.run.groupSpace,
            spawnedBy: turn.followupRun.run.spawnedBy,
            chatId: turn.followupRun.originatingChatId,
            currentThreadTs: cliCurrentThreadId != null ? String(cliCurrentThreadId) : undefined,
            currentMessageId: cliCurrentMessageId,
            replyToMode: cliReplyToMode,
            currentInboundAudio: hasInboundAudio(turn.sessionCtx),
            agentAccountId: turn.followupRun.run.agentAccountId,
            skillLibraryAuthoring: params.candidateRun.skillLibraryAuthoring,
            toolAuthorityFingerprint,
            // Native input is already host-authored. Keep its stable delivery
            // context out of the model-output normalization wrapper.
            onBlockReply: onNativeBlockReply,
            onPartialReply: turn.opts?.onPartialReply,
            onExecutionPhase: params.signalExecutionPhaseForTyping,
          },
        });
        if (droppedCliSessionReplacement) {
          // The room-event transform removed native continuity; only its guarded
          // invalidation remains, and failure must retain the returned turn.
          return await settleCliSessionResult(candidateResult, async () => {
            await clearCliBinding();
            params.classifyResult(candidateResult);
          });
        }
        return settleResult({
          result: candidateResult,
          expectedSession: sessionEntry,
          sessionStore: turn.activeSessionStore,
          preserveBinding: shouldPreserveUserFacingSessionStateForInputProvenance(
            turn.followupRun.run.inputProvenance,
          ),
        });
      },
    ),
  );
}

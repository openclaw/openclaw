import { settleProgressVisibilityCallbackResult } from "../../channels/progress-visibility.js";
import { sessionPersonalProfileId } from "../../config/sessions/session-entry-provenance.js";
import { logVerbose } from "../../globals.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { withCurrentUserTurnInput } from "../../sessions/user-turn-transcript-runtime-context.js";
import { isFastModeAutoProgressPayload } from "../reply-payload.js";
import type { TemplateContext } from "../templating.js";
import type { VerboseLevel } from "../thinking.js";
import type { ReplyPayload } from "../types.js";
import { executeAgentTurn } from "./agent-runner-execution.js";
import type { AgentTurnExecutionResult } from "./agent-runner-execution.types.js";
import { buildTerminalAgentRunFailureReplyPayload } from "./agent-runner-failure-reply.js";
import { resolveFollowupCurrentMessageId } from "./agent-runner-utils.js";
import { resolveTurnCommentaryProgressOwner } from "./commentary-progress-owner.js";
import { requiresDurableToolResultDelivery } from "./dispatch-from-config.payloads.js";
import type { AdmittedFollowupTurn, FollowupRunnerParams } from "./followup-turn-admission.js";
import type { InternalGetReplyOptions } from "./get-reply.types.js";
import { drainPendingToolTasks } from "./pending-tool-task-drain.js";
import { recordReplyOperationAgentTurn } from "./reply-operation-run-state.js";
import { hasReplyOperationExecutionStarted, replyRunRegistry } from "./reply-run-registry.js";
import { captureReplyOperationSessionReader } from "./reply-run-registry.state.js";
import { prepareReplyToolAuthority } from "./reply-tool-authority.js";
import { prepareSessionVerboseLevelReader } from "./session-verbose-level.js";
import { resolveFollowupReplyExpectation } from "./source-reply-delivery-mode.js";
import { resolveReplySourceTurnId, setChannelSourceTurnId } from "./source-turn-id.js";
import { createTypingSignaler, type TypingSignaler } from "./typing-mode.js";

export type FollowupExecutionResult = {
  commentaryPayloadsEnabled: boolean;
  execution: AgentTurnExecutionResult;
  runStartedAt: number;
  sessionCtx: TemplateContext;
  pendingToolTasks: Set<Promise<void>>;
  progress: {
    drain(): Promise<void>;
  };
};

function buildFollowupTemplateContext(turn: AdmittedFollowupTurn): TemplateContext {
  const queued = turn.queued;
  const run = queued.run;
  const surface = queued.originatingChannel ?? run.messageProvider;
  const sessionKey = turn.session.kind === "session" ? turn.session.key : run.sessionKey;
  const currentMessageId = resolveFollowupCurrentMessageId(queued);
  return {
    Provider: run.messageProvider,
    Surface: surface,
    OriginatingChannel: queued.originatingChannel,
    OriginatingTo: queued.originatingTo,
    To: queued.originatingTo,
    AccountId: queued.originatingAccountId ?? run.agentAccountId,
    ChatType: queued.originatingChatType ?? run.chatType,
    SessionKey: sessionKey,
    RuntimePolicySessionKey: run.runtimePolicySessionKey ?? sessionKey,
    MessageSid: currentMessageId,
    MessageSidFull: currentMessageId,
    MessageThreadId: queued.originatingThreadId,
    ReplyToId: queued.originatingReplyToId,
    SenderId: run.senderId,
    MemberRoleIds: run.memberRoleIds,
    ChannelContext: run.channelContext,
    SenderName: run.senderName,
    SenderUsername: run.senderUsername,
    SenderE164: run.senderE164,
    GroupChannel: run.groupChannel,
    GroupSpace: run.groupSpace,
    InputProvenance: run.inputProvenance,
    InboundEventKind: queued.currentInboundEventKind,
    media: queued.media,
  };
}

/** Adapts an admitted queued turn to the canonical agent execution owner. */
export async function executeFollowupTurn(params: {
  turn: AdmittedFollowupTurn;
  defaults: FollowupRunnerParams;
  onToolResult: (payload: ReplyPayload) => Promise<void>;
  onCompactionNoticePayload: (payload: ReplyPayload) => Promise<void>;
}): Promise<FollowupExecutionResult> {
  const { turn, defaults } = params;
  const sourceOpts = defaults.opts;
  const terminalReplyExpectation = resolveFollowupReplyExpectation(turn.queued, turn.config);
  turn.queued.run.terminalReplyExpectation = terminalReplyExpectation;
  // Queued turns are never heartbeats; heartbeat runs never supply the drain callback.
  const isHeartbeat = false;
  const roomEvent = turn.queued.currentInboundEventKind === "room_event";
  const deliveryAllowed = () => turn.sendPolicy === "allow" && !roomEvent;
  const progressAllowed = () =>
    deliveryAllowed() &&
    (sourceOpts?.progressRequiresReply !== true || terminalReplyExpectation === "required");
  const assertProgressCurrent = () => {
    turn.operation.abortSignal.throwIfAborted();
    turn.queued.operatorAuthority?.assertCurrent();
    if (turn.operation.result) {
      throw new Error("Follow-up progress owner has settled");
    }
  };
  const readVerboseLevel = await prepareSessionVerboseLevelReader({
    scope:
      turn.session.kind === "session" &&
      turn.session.storePath &&
      turn.queued.run.verboseLevelOverride === undefined
        ? {
            storePath: turn.session.storePath,
            sessionKey: turn.session.key,
          }
        : undefined,
    initialLevel:
      turn.session.kind === "session" && turn.session.storePath
        ? turn.session.current()?.verboseLevel
        : undefined,
    assertCurrent: assertProgressCurrent,
  });
  const currentVerboseLevel = (): VerboseLevel => {
    const level =
      turn.queued.run.verboseLevelOverride ??
      readVerboseLevel() ??
      turn.session.current()?.verboseLevel ??
      turn.queued.run.verboseLevel;
    return level === "on" || level === "full" ? level : "off";
  };
  const forceToolResultProgress = sourceOpts?.forceToolResultProgress === true;
  const channelToolResultProgress = forceToolResultProgress ? sourceOpts.onToolResult : undefined;
  const shouldEmitVerboseToolResult = () => {
    const level = currentVerboseLevel();
    return level === "on" || level === "full";
  };
  const shouldEmitToolResult = () =>
    progressAllowed() && (forceToolResultProgress || shouldEmitVerboseToolResult());
  const shouldEmitToolOutput = () => progressAllowed() && currentVerboseLevel() === "full";
  // Quiet channel drafts consume typed activity without enabling formatted result text.
  const shouldEmitStructuredProgress = () =>
    progressAllowed() &&
    (sourceOpts?.suppressDefaultToolProgressMessages === true || shouldEmitToolResult());
  const shouldEmitToolLifecycle = () =>
    progressAllowed() &&
    (shouldEmitStructuredProgress() || sourceOpts?.allowToolLifecycleWhenProgressHidden === true);
  const { commentaryPayloadsEnabled, draftOwnsCommentaryProgress } =
    await resolveTurnCommentaryProgressOwner({
      commentaryPayloadsEnabled: sourceOpts?.commentaryPayloadsEnabled === true,
      options: sourceOpts,
      resolveVerboseProgressVisibility: () => progressAllowed() && shouldEmitVerboseToolResult(),
      resolveVerboseProgressVisibilityAsync: async () => {
        assertProgressCurrent();
        return progressAllowed() && shouldEmitVerboseToolResult();
      },
    });
  turn.operation.abortSignal.throwIfAborted();
  turn.queued.operatorAuthority?.assertCurrent();
  let progressChain: Promise<void> = Promise.resolve();
  let visibleReplyDelivered = false;
  const pendingTaskFailures: { progress?: unknown; tool?: unknown } = {};
  const pendingWorkTasks = new Set<Promise<void>>();
  const trackPendingWork = (task: Promise<void>, kind: "progress" | "tool") => {
    const observedTask = task.catch((error: unknown) => {
      pendingTaskFailures[kind] ??= error;
      throw error;
    });
    const watcher = observedTask.finally(() => pendingWorkTasks.delete(watcher));
    void watcher.catch(() => undefined);
    pendingWorkTasks.add(watcher);
  };
  const enqueueProgress = (deliver: () => Promise<void> | void): Promise<void> => {
    const deliveryTask = progressChain.then(deliver);
    progressChain = deliveryTask.catch(() => undefined);
    trackPendingWork(deliveryTask, "progress");
    return progressChain;
  };
  const enqueueProgressResult = async (
    deliver: () => Promise<boolean | void> | boolean | void,
  ): Promise<boolean | void> => {
    let result: boolean | void = false;
    await enqueueProgress(async () => {
      result = await deliver();
      visibleReplyDelivered ||= result !== false;
    });
    return result;
  };
  const wrap = <T>(callback: ((value: T) => unknown) | undefined, allowed = progressAllowed) =>
    callback
      ? (value: T) =>
          enqueueProgress(async () => {
            if (allowed()) {
              await callback(value);
            }
          })
      : undefined;
  const wrapVisibility = <Args extends unknown[]>(
    callback: ((...args: Args) => Promise<boolean | void> | boolean | void) | undefined,
    allowed: (...args: Args) => boolean = progressAllowed,
  ) =>
    callback
      ? (...args: Args) =>
          enqueueProgressResult(async () => {
            if (!allowed(...args)) {
              return false;
            }
            return (await settleProgressVisibilityCallbackResult(callback(...args))).visible;
          })
      : undefined;
  const baseTypingSignals = createTypingSignaler({
    typing: defaults.typing,
    mode: progressAllowed() ? defaults.typingMode : "never",
    isHeartbeat,
  });
  const typingSignals: TypingSignaler = {
    ...baseTypingSignals,
    signalRunStart: () => enqueueProgress(baseTypingSignals.signalRunStart),
    signalMessageStart: () => enqueueProgress(baseTypingSignals.signalMessageStart),
    signalTextDelta: (text) => enqueueProgress(() => baseTypingSignals.signalTextDelta(text)),
    signalReasoningDelta: () => enqueueProgress(baseTypingSignals.signalReasoningDelta),
    signalToolStart: () => enqueueProgress(baseTypingSignals.signalToolStart),
    signalExecutionActivity: () =>
      enqueueProgress(
        baseTypingSignals.signalExecutionActivity ?? baseTypingSignals.signalRunStart,
      ),
  };
  const progressOpts: InternalGetReplyOptions = {
    ...sourceOpts,
    isHeartbeat,
    sourceReplyDeliveryMode: turn.queued.run.sourceReplyDeliveryMode,
    internalEventExecution: turn.queued.run.internalEventExecution,
    // A refreshed runner owns presentation defaults, never another source's authority or callbacks.
    operatorAuthority: turn.queued.operatorAuthority,
    abortSignal: turn.operation.abortSignal,
    toolsAllow: turn.queued.toolsAllow,
    disableTools: turn.queued.disableTools,
    onAgentRunStart: turn.queued.runObservers?.onAgentRunStart,
    onAgentRunTerminalOutcome: turn.queued.runObservers?.onAgentRunTerminalOutcome,
    onModelSelected: turn.queued.runObservers?.onModelSelected,
    prepareAssistantTranscriptMessage: turn.queued.runObservers?.prepareAssistantTranscriptMessage,
    resolveReplyDelivery: turn.queued.runObservers?.resolveReplyDelivery,
    onDeliberateSilentTerminalReply: turn.queued.runObservers?.onDeliberateSilentTerminalReply,
    commentaryPayloadsEnabled,
    runId: turn.runId,
    onBlockReply: undefined,
    onPreparedBlockReply: undefined,
    onPartialReply: undefined,
    onAssistantMessageStart: undefined,
    onToolStart: wrapVisibility(sourceOpts?.onToolStart, shouldEmitToolLifecycle),
    onCommandOutput: wrapVisibility(sourceOpts?.onCommandOutput, shouldEmitStructuredProgress),
    onItemEvent: wrapVisibility<Parameters<NonNullable<InternalGetReplyOptions["onItemEvent"]>>>(
      sourceOpts?.onItemEvent ? (item) => sourceOpts.onItemEvent!(item) : undefined,
      (item) =>
        // Only the explicit draft owner may bypass hidden tool-progress filtering for preambles.
        (progressAllowed() && item.kind === "preamble" && draftOwnsCommentaryProgress) ||
        shouldEmitStructuredProgress(),
    ),
    onNarrationUpdate: wrap(sourceOpts?.onNarrationUpdate),
    onPlanUpdate: wrapVisibility(sourceOpts?.onPlanUpdate),
    onApprovalEvent: wrapVisibility(sourceOpts?.onApprovalEvent, shouldEmitStructuredProgress),
    onPatchSummary: wrapVisibility(sourceOpts?.onPatchSummary, shouldEmitStructuredProgress),
    onCompactionStart: wrapVisibility(sourceOpts?.onCompactionStart),
    onCompactionEnd: wrapVisibility(sourceOpts?.onCompactionEnd),
    onReasoningStream: wrapVisibility(sourceOpts?.onReasoningStream),
    onReasoningProgress: wrap(sourceOpts?.onReasoningProgress),
    onReasoningEnd: wrapVisibility(sourceOpts?.onReasoningEnd),
    onToolResult: async (payload) => {
      return await enqueueProgressResult(async () => {
        const requiresDurableToolResult = requiresDurableToolResultDelivery(payload);
        if (!deliveryAllowed() || (!requiresDurableToolResult && !progressAllowed())) {
          return false;
        }
        if (sourceOpts?.suppressToolProgressMessages && !requiresDurableToolResult) {
          return false;
        }
        const fastModeAutoProgress =
          isFastModeAutoProgressPayload(payload) && !requiresDurableToolResult;
        const verboseToolResult = !requiresDurableToolResult && shouldEmitVerboseToolResult();
        const transientToolResultProgress = requiresDurableToolResult
          ? undefined
          : channelToolResultProgress;
        let callback = verboseToolResult ? undefined : transientToolResultProgress;
        if (fastModeAutoProgress) {
          const lifecycleToolResult = sourceOpts?.allowToolLifecycleWhenProgressHidden === true;
          const sourceDeliverySuppressed =
            turn.queued.run.sourceReplyDeliveryMode === "message_tool_only";
          const callbackAllowedBySource =
            !sourceDeliverySuppressed ||
            sourceOpts?.allowProgressCallbacksWhenSourceDeliverySuppressed === true;
          const callbackAllowed =
            callbackAllowedBySource &&
            (forceToolResultProgress || verboseToolResult || lifecycleToolResult);
          callback = callbackAllowed ? sourceOpts?.onToolResult : undefined;
        } else if (
          turn.queued.run.sourceReplyDeliveryMode === "message_tool_only" &&
          !transientToolResultProgress &&
          !verboseToolResult &&
          !requiresDurableToolResult
        ) {
          return false;
        }
        if (callback) {
          const visible = (await settleProgressVisibilityCallbackResult(callback(payload))).visible;
          // Ordinary progress delegates completely; fast-mode hints retain a durable fallback.
          if (visible || !fastModeAutoProgress) {
            return visible;
          }
        }
        if (fastModeAutoProgress && !forceToolResultProgress && !verboseToolResult) {
          return false;
        }
        await params.onToolResult(payload);
        return true;
      });
    },
  };
  const pendingToolTasks = new (class extends Set<Promise<void>> {
    override add(task: Promise<void>): this {
      trackPendingWork(task, "tool");
      return super.add(task);
    }
  })();
  let pendingWorkDrain: Promise<void> | undefined;
  const drainPendingWork = () => {
    pendingWorkDrain ??= (async () => {
      await drainPendingToolTasks({ tasks: pendingWorkTasks, onTimeout: logVerbose });
      // This terminal owner gets one bounded wait. Retire the accounting handoff
      // so timed-out tool delivery cannot start a second idle window.
      pendingToolTasks.clear();
    })();
    return pendingWorkDrain;
  };
  const sessionCtx = buildFollowupTemplateContext(turn);
  if (turn.preflightError) {
    throw turn.preflightError instanceof Error
      ? turn.preflightError
      : new Error(formatErrorMessage(turn.preflightError));
  }
  let execution: AgentTurnExecutionResult;
  const runStartedAt = Date.now();
  if (turn.preflightFailurePayload) {
    execution = {
      runId: turn.runId,
      outcome: { kind: "rejected", payload: turn.preflightFailurePayload },
    };
  } else {
    try {
      turn.queued.run.bootstrapUserProfileId = turn.queued.personalBootstrapEligible
        ? sessionPersonalProfileId(turn.session.current())
        : undefined;
      await turn.operation.bindToolAuthoritySnapshotAsync(
        prepareReplyToolAuthority(
          turn.queued,
          undefined,
          captureReplyOperationSessionReader(turn.operation),
        ),
      );
      turn.operation.setPhase("running");
      const gatewayOwnsCompletion =
        turn.queued.queuedFollowupReplyDisposition?.kind === "deliver" &&
        turn.queued.queuedFollowupReplyDisposition.deliver.ownsCompletion?.(
          turn.queued.originatingChannel,
        ) === true;
      if (gatewayOwnsCompletion) {
        turn.queued.run.mediaNormalizationOwner = "gateway";
      }
      const execute = () =>
        executeAgentTurn({
          completionSource: gatewayOwnsCompletion ? "reply-dispatch" : undefined,
          commandBody: turn.queued.prompt,
          transcriptCommandBody: turn.queued.transcriptPrompt,
          followupRun: turn.queued,
          sessionCtx,
          replyOperation: turn.operation,
          opts: progressOpts,
          resolveVisibleReplyDelivery: async () => {
            await drainPendingWork();
            return visibleReplyDelivered;
          },
          typingSignals,
          blockReplyPipeline: null,
          blockStreamingEnabled: false,
          resolvedBlockStreamingBreak: turn.queued.run.blockReplyBreak,
          applyReplyToMode: (payload) => payload,
          shouldEmitToolResult,
          shouldEmitToolOutput,
          pendingToolTasks,
          isHeartbeat,
          sessionKey: turn.session.kind === "session" ? turn.session.key : undefined,
          runtimePolicySessionKey: turn.queued.run.runtimePolicySessionKey,
          getActiveSessionEntry: turn.session.current,
          activeSessionStore: turn.sessionStore,
          storePath: turn.session.kind === "session" ? turn.session.storePath : undefined,
          resolvedVerboseLevel: currentVerboseLevel(),
          toolProgressDetail: defaults.toolProgressDetail,
          onCompactionNoticePayload: async (payload) => {
            await enqueueProgressResult(async () => {
              if (!progressAllowed()) {
                return false;
              }
              await params.onCompactionNoticePayload(payload);
              return true;
            });
          },
        });
      const recorder = turn.queued.userTurnTranscriptRecorder;
      // Queued execution outlives its ingress scope. Re-enter the exact source
      // custody after lazy collection binds it, so runtime appends consume all sources.
      await recorder?.resolveMessage();
      turn.operation.abortSignal.throwIfAborted();
      const sourceTurnId = resolveReplySourceTurnId({
        sourceTurnId: turn.queued.sourceTurnId,
        admissionRunId: turn.queued.messageId,
        ingressProvider: turn.queued.run.messageProvider,
        entry: turn.session.current(),
      });
      if (sourceTurnId) {
        replyRunRegistry.bindSourceTurnId(turn.operation, sourceTurnId);
        setChannelSourceTurnId(sessionCtx, sourceTurnId);
      }
      execution = await withCurrentUserTurnInput(recorder, execute);
    } catch (error) {
      await drainPendingWork();
      if (!hasReplyOperationExecutionStarted(turn.operation)) {
        throw error;
      }
      turn.operation.fail("run_failed", error);
      execution = {
        runId: turn.runId,
        outcome: {
          kind: "rejected",
          payload: buildTerminalAgentRunFailureReplyPayload({
            isHeartbeat,
            replyExpectation: terminalReplyExpectation,
            visibleReplyDelivered,
          }),
        },
      };
    }
  }
  // Runner defaults may be newer; only the queued sources own this execution result.
  recordReplyOperationAgentTurn(
    turn.queued.replyOperationRunStates,
    turn.operation,
    execution.outcome,
  );
  return {
    commentaryPayloadsEnabled,
    execution,
    runStartedAt,
    sessionCtx,
    pendingToolTasks,
    progress: {
      drain: async () => {
        await drainPendingWork();
        const firstFailure: unknown = pendingTaskFailures.progress ?? pendingTaskFailures.tool;
        if (firstFailure !== undefined) {
          throw firstFailure instanceof Error
            ? firstFailure
            : new Error(formatErrorMessage(firstFailure));
        }
      },
    },
  };
}

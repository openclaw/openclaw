import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveAgentWorkspaceDir, resolveSessionAgentId } from "../../agents/agent-scope.js";
import { resolveGroupToolPolicy } from "../../agents/agent-tools.policy.js";
import { resolveReplyCompletion } from "../../agents/reply-completion.js";
import { normalizeChatType } from "../../channels/chat-type.js";
import { resolveGroupSessionKey } from "../../config/sessions/group.js";
import { prepareSessionPendingInputDedupeRecovery } from "../../config/sessions/session-accessor.pending-inputs.js";
import { logVerbose } from "../../globals.js";
import { toPluginConversationBinding } from "../../plugins/conversation-binding.js";
import { resolveSendPolicy } from "../../sessions/send-policy.js";
import { sessionDeliveryChannel } from "../../utils/delivery-context.read.js";
import { resolveCommandTurnContext } from "../command-turn-context.js";
import { isExplicitCommandTurnContext } from "../command-turn-detection.js";
import { isActiveRunSafeCommandTurn } from "../commands-registry.js";
import type { ReplyPayload } from "../reply-payload.js";
import { capturePendingConversationTurnReply } from "./conversation-turn-capture.js";
import { resolveSessionStoreLookup } from "./dispatch-from-config.context.js";
import type { PluginBindingTranscriptOwner } from "./dispatch-from-config.events.js";
import {
  resolveTurnModelOverride,
  resolveVisibleRepliesPolicy,
} from "./dispatch-from-config.harness-defaults.js";
import type { PrepareDispatchDeliveryReadyState } from "./dispatch-from-config.prepare-delivery.js";
import type { DispatchFromConfigResult } from "./dispatch-from-config.types.js";
import { claimInboundDedupe } from "./inbound-dedupe.js";
import { emitMessageReceivedHooks as emitSharedMessageReceivedHooks } from "./message-received-hooks.js";
import { resolveOriginMessageProvider } from "./origin-routing.js";
import { waitForReplyDispatcherIdle } from "./reply-dispatcher-idle.js";
import { recordReplyOperationAgentTurn } from "./reply-operation-run-state.js";
import { isDuplicateRestartRecoverySource } from "./restart-recovery-source.js";
import { resolveDispatchConversationBinding } from "./session-conversation-binding.js";
import {
  resolveReplyMessageToolAvailability,
  resolveStableMessageToolAvailability,
} from "./session-stable-reply-mode.js";
import {
  resolveSourceReplyExpectation,
  isUnauthorizedTextSlashCommand,
  resolveSourceReplyVisibilityPolicy,
} from "./source-reply-delivery-mode.js";
import type { SourceReplyDeliveryRuntimeOptions } from "./source-reply-delivery-runtime.js";
import {
  buildChannelSourceTurnId,
  readChannelSourceTurnId,
  setChannelSourceTurnId,
  shouldMintChannelSourceTurnId,
} from "./source-turn-id.js";
import {
  isReplyOperationStalledBeforeOutput,
  STALLED_TURN_NOTICE_TEXT,
} from "./stalled-turn-recovery.js";

export async function prepareDispatchOperationContext(state: PrepareDispatchDeliveryReadyState) {
  const {
    acpDispatchSessionKey,
    buildMessageReceivedHookContext,
    cfg,
    ctx,
    dispatcher,
    hookRunner,
    isInternalWebchatTurn,
    markIdle,
    params,
    recordAgentDispatchCompleted,
    recordProcessed,
    replyRoute,
    sessionAgentId,
    sessionKey,
    sessionStoreEntry,
  } = state;
  const sendBindingNotice = async (
    payload: ReplyPayload,
    mode: "additive" | "terminal",
    transcriptOwner?: PluginBindingTranscriptOwner,
  ): Promise<boolean> => {
    if (sourceReplyPolicy.suppressAutomaticSourceDelivery) {
      return false;
    }
    return await state.deliverBindingPayload(payload, mode, transcriptOwner);
  };

  const pluginOwnedBindingRecord = state.allowInboundHandlers
    ? await resolveDispatchConversationBinding(cfg, ctx)
    : null;
  const pluginOwnedBinding = toPluginConversationBinding(pluginOwnedBindingRecord);
  const pluginBindingSessionKey = normalizeOptionalString(
    pluginOwnedBindingRecord?.targetSessionKey,
  );
  const pluginBindingTargetKind = pluginOwnedBindingRecord?.targetKind;
  const persistPluginBindingUserTurn = async (): Promise<
    PluginBindingTranscriptOwner | undefined
  > => {
    const recorder = params.replyOptions?.userTurnTranscriptRecorder;
    if (!recorder || !pluginBindingSessionKey) {
      return undefined;
    }
    const targetAgentId = resolveSessionAgentId({
      sessionKey: pluginBindingSessionKey,
      config: cfg,
      fallbackAgentId: ctx.AgentId,
    });
    const blockedOwner = (expectedSessionId?: string): PluginBindingTranscriptOwner => ({
      agentId: targetAgentId,
      sessionKey: pluginBindingSessionKey,
      ...(expectedSessionId ? { expectedSessionId } : {}),
      transcriptWriteBlocked: true,
    });
    if (recorder.hasPersisted()) {
      return blockedOwner();
    }
    const assertCurrent = () => {
      state.getPreDispatchAbortSignal()?.throwIfAborted();
      params.replyOptions?.operatorAuthority?.assertCurrent();
    };
    let lastOwner: PluginBindingTranscriptOwner | undefined;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const targetSessionStoreEntry = await resolveSessionStoreLookup(
        {
          ...ctx,
          CommandTargetSessionKey: undefined,
          SessionKey: pluginBindingSessionKey,
        },
        cfg,
        assertCurrent,
      );
      assertCurrent();
      const targetSessionEntry = targetSessionStoreEntry.entry;
      if (!targetSessionEntry || targetSessionEntry.sessionId === lastOwner?.expectedSessionId) {
        break;
      }
      lastOwner = {
        agentId: targetAgentId,
        expectedSessionId: targetSessionEntry.sessionId,
        sessionKey: pluginBindingSessionKey,
      };
      const result = await recorder.persistApproved({
        target: {
          sessionId: targetSessionEntry.sessionId,
          sessionKey: pluginBindingSessionKey,
          sessionEntry: targetSessionEntry,
          ...(targetSessionStoreEntry.store ? { sessionStore: targetSessionStoreEntry.store } : {}),
          storePath: targetSessionStoreEntry.storePath,
          agentId: targetAgentId,
          cwd: resolveAgentWorkspaceDir(cfg, targetAgentId),
          config: cfg,
        },
        expectedSessionId: targetSessionEntry.sessionId,
        retryIfUnpersisted: true,
      });
      if (result) {
        return lastOwner;
      }
    }
    recorder.markBlocked();
    if (lastOwner) {
      logVerbose(`plugin-bound user-turn persistence skipped after the target session changed`);
    }
    return blockedOwner(lastOwner?.expectedSessionId);
  };

  // Resolve automatic source-delivery suppression early so every outbound path
  // below (plugin-binding notices, fast-abort, normal dispatch) honors it. The
  // agent still processes inbound, but automatic replies/notices/indicators are
  // blocked; explicit message tool sends remain available.
  const sendPolicy = resolveSendPolicy({
    cfg,
    entry: sessionStoreEntry.entry,
    sessionKey: sessionStoreEntry.sessionKey ?? sessionKey,
    channel:
      (state.shouldRouteToOriginating ? state.routeReplyChannel : undefined) ??
      sessionDeliveryChannel(sessionStoreEntry.entry) ??
      replyRoute.channel ??
      ctx.Surface ??
      ctx.Provider ??
      undefined,
    chatType: sessionStoreEntry.entry?.chatType,
  });
  const chatType = normalizeChatType(ctx.ChatType);
  state.replyOperationRunState.replyCompletion = resolveReplyCompletion(
    resolveSourceReplyExpectation({ ctx, cfg, isHeartbeat: params.replyOptions?.isHeartbeat }),
    "empty",
  );
  const { configuredVisibleReplies, harnessDefaultVisibleReplies } = resolveVisibleRepliesPolicy({
    cfg,
    chatType,
    ctx,
    entry: sessionStoreEntry.entry,
    sessionAgentId,
    sessionKey: acpDispatchSessionKey,
    sessionStore: sessionStoreEntry.store,
    turnModelOverride: resolveTurnModelOverride(params.replyOptions),
  });
  const effectiveVisibleReplies = configuredVisibleReplies ?? harnessDefaultVisibleReplies;
  const prefersMessageToolDelivery =
    params.replyOptions?.sourceReplyDeliveryMode === "message_tool_only" ||
    (ctx.InboundEventKind === "room_event" && !isInternalWebchatTurn) ||
    (params.replyOptions?.sourceReplyDeliveryMode === undefined &&
      !isExplicitCommandTurnContext(ctx, cfg) &&
      (configuredVisibleReplies === "message_tool" ||
        (!isInternalWebchatTurn && effectiveVisibleReplies === "message_tool")));
  const groupResolution = resolveGroupSessionKey(ctx);
  const messageProvider = resolveOriginMessageProvider({
    originatingChannel: ctx.OriginatingChannel,
    provider: ctx.Provider ?? ctx.Surface,
  });
  const groupPolicy = resolveGroupToolPolicy({
    config: cfg,
    sessionKey: acpDispatchSessionKey,
    messageProvider,
    groupId: groupResolution?.id,
    groupChannel:
      normalizeOptionalString(ctx.GroupChannel) ?? normalizeOptionalString(ctx.GroupSubject),
    groupSpace: normalizeOptionalString(ctx.GroupSpace),
    accountId: ctx.AccountId,
    senderId: normalizeOptionalString(ctx.SenderId),
    senderName: normalizeOptionalString(ctx.SenderName),
    senderUsername: normalizeOptionalString(ctx.SenderUsername),
    senderE164: normalizeOptionalString(ctx.SenderE164),
  });
  const messageToolAvailable = resolveReplyMessageToolAvailability({
    cfg,
    sessionAgentId,
    sessionKey: acpDispatchSessionKey,
    groupPolicy,
    prefersMessageToolDelivery,
  });
  // The stable mode's tool-only downgrade must be sender-independent, or a
  // sender-scoped message denial hashes a different binding policy than the
  // sender-less synthetic turns on the same session. Only tool-only candidates
  // can downgrade, so skip the second policy pass otherwise.
  const sessionStableMessageToolAvailable =
    effectiveVisibleReplies === "message_tool"
      ? resolveStableMessageToolAvailability({
          cfg,
          ctx,
          sessionEntry: sessionStoreEntry.entry,
          sessionAgentId,
          sessionKey: acpDispatchSessionKey,
        })
      : undefined;
  const sourceReplyPolicyParams = {
    cfg,
    ctx,
    strictMessageToolOnly: ctx.InboundEventKind === "room_event" && !isInternalWebchatTurn,
    sendPolicy,
    suppressAcpChildUserDelivery: state.suppressAcpChildUserDelivery,
    explicitSuppressTyping: params.replyOptions?.suppressTyping === true,
    shouldSuppressTyping: state.shouldSuppressTyping,
    messageToolAvailable,
    sessionStableMessageToolAvailable,
    isHeartbeat: params.replyOptions?.isHeartbeat,
    requested: params.replyOptions?.sourceReplyDeliveryMode,
  } as const;
  let sourceReplyPolicy = resolveSourceReplyVisibilityPolicy({
    ...sourceReplyPolicyParams,
    defaultVisibleReplies: harnessDefaultVisibleReplies,
  });
  const alternateHarnessDefault =
    harnessDefaultVisibleReplies === "message_tool" ? "automatic" : "message_tool";
  const alternateSourceReplyDeliveryMode = resolveSourceReplyVisibilityPolicy({
    ...sourceReplyPolicyParams,
    defaultVisibleReplies: alternateHarnessDefault,
  }).sourceReplyDeliveryMode;
  const sourceReplyDeliveryModeOrigin =
    alternateSourceReplyDeliveryMode === sourceReplyPolicy.sourceReplyDeliveryMode
      ? "stable_policy"
      : "runtime_default";
  const sourceReplyDeliveryRuntimeOptions: SourceReplyDeliveryRuntimeOptions = {
    sourceReplyDeliveryModeOrigin,
    onSourceReplyDeliveryModeResolved: (mode) => {
      const stableMode = sourceReplyPolicy.sessionStableSourceReplyDeliveryMode;
      sourceReplyPolicy = resolveSourceReplyVisibilityPolicy({
        ...sourceReplyPolicyParams,
        requested: mode,
      });
      // A candidate can change live ownership, but not the reusable CLI session prompt.
      sourceReplyPolicy.sessionStableSourceReplyDeliveryMode = stableMode;
      Object.assign(state, sourceReplyPolicy, { sourceReplyPolicy });
    },
  };
  Object.assign(sourceReplyPolicy, sourceReplyDeliveryRuntimeOptions);
  const reasoningPayloadsEnabled = params.replyOptions?.reasoningPayloadsEnabled === true;
  const commentaryPayloadsEnabled = params.replyOptions?.commentaryPayloadsEnabled === true;
  const attachSourceReplyDeliveryMode = (
    result: DispatchFromConfigResult,
  ): DispatchFromConfigResult =>
    sourceReplyPolicy.sourceReplyDeliveryMode === "message_tool_only" ||
    sourceReplyPolicy.sendPolicyDenied
      ? {
          ...result,
          ...(sourceReplyPolicy.sourceReplyDeliveryMode === "message_tool_only"
            ? { sourceReplyDeliveryMode: sourceReplyPolicy.sourceReplyDeliveryMode }
            : {}),
          ...(sourceReplyPolicy.sendPolicyDenied ? { sendPolicyDenied: true } : {}),
        }
      : result;
  const baseDispatchResult = (queuedFinal = false) => ({
    queuedFinal,
    counts: dispatcher.getQueuedCounts(),
  });
  const explicitCommandTurnCtx = isExplicitCommandTurnContext(ctx, cfg);
  const activeRunSafeCommandTurn =
    explicitCommandTurnCtx &&
    isActiveRunSafeCommandTurn({
      commandTurn: resolveCommandTurnContext(ctx),
      cfg,
      provider: ctx.Provider ?? ctx.Surface,
    });
  const unauthorizedTextSlashSourceReplyCtx =
    (chatType === "group" || chatType === "channel") && isUnauthorizedTextSlashCommand(ctx);
  const shouldDeliverPluginBindingReply =
    !sourceReplyPolicy.suppressAutomaticSourceDelivery ||
    explicitCommandTurnCtx ||
    (ctx.InboundEventKind !== "room_event" && !unauthorizedTextSlashSourceReplyCtx);
  const skipDuplicate = () => {
    recordProcessed("skipped", { reason: "duplicate" });
    return {
      status: "complete" as const,
      result: attachSourceReplyDeliveryMode(baseDispatchResult()),
    };
  };

  const durableSourceTurnId =
    readChannelSourceTurnId(ctx) ??
    (shouldMintChannelSourceTurnId(ctx.Provider ?? ctx.Surface)
      ? buildChannelSourceTurnId({
          provider: resolveOriginMessageProvider({
            originatingChannel: replyRoute.channel,
            provider: ctx.Provider ?? ctx.Surface,
          }),
          accountId: replyRoute.accountId,
          conversationId: replyRoute.to,
          messageId:
            normalizeOptionalString(ctx.MessageSidFull) ?? normalizeOptionalString(ctx.MessageSid),
        })
      : undefined);
  // Compute once before hooks. The prepared agent turn reuses this exact route-scoped id.
  setChannelSourceTurnId(ctx, durableSourceTurnId);
  if (isDuplicateRestartRecoverySource(sessionStoreEntry.entry, durableSourceTurnId)) {
    // Process-local inbound dedupe cannot see provider redelivery after restart.
    // Drop durable duplicates before any plugin dispatch hook can repeat effects.
    return skipDuplicate();
  }

  const sourceRunId = normalizeOptionalString(ctx.MessageSid);
  const recorder = params.replyOptions?.userTurnTranscriptRecorder;
  let reclaimPendingInput: (() => boolean) | undefined;
  if (
    recorder?.getPendingInputMessage?.() &&
    !recorder.hasPersisted() &&
    sourceRunId &&
    sessionStoreEntry.sessionKey &&
    sessionStoreEntry.entry?.sessionId
  ) {
    const recoveryScope = {
      agentId: sessionStoreEntry.agentId ?? sessionAgentId,
      storePath: sessionStoreEntry.storePath,
      sessionKey: sessionStoreEntry.sessionKey,
      sessionId: sessionStoreEntry.entry.sessionId,
    };
    reclaimPendingInput = await prepareSessionPendingInputDedupeRecovery(
      recoveryScope,
      sourceRunId,
    );
  }
  const claimInput = () => {
    const reclaim = reclaimPendingInput;
    return claimInboundDedupe(ctx, {
      reclaimPendingInput: reclaim ? () => !recorder!.hasPersisted() && reclaim() : undefined,
    });
  };
  const inboundDedupeClaim =
    reclaimPendingInput && recorder?.withPendingInputCurrent
      ? await recorder.withPendingInputCurrent(claimInput)
      : claimInput();
  if (inboundDedupeClaim.status === "duplicate" || inboundDedupeClaim.status === "inflight") {
    return skipDuplicate();
  }
  const commitInboundDedupeIfClaimed = () => inboundDedupeClaim.commit?.();
  const releaseInboundDedupeIfClaimed = () => inboundDedupeClaim.release?.();
  const lifecycle = params.replyOptions?.turnAdoptionLifecycle;
  if (lifecycle && inboundDedupeClaim.status === "claimed") {
    const onAbandoned = lifecycle.onAbandoned;
    lifecycle.onAbandoned = () => {
      // Release before ingress retries, including abandonment before commit.
      if (!state.inboundDedupeReplayUnsafe && !state.turnAdoptionState?.adopted) {
        inboundDedupeClaim.release();
      }
      onAbandoned?.();
    };
  }
  const finishReplyOperationBusyDispatch = (opts?: {
    dedupeDisposition?: "commit" | "release";
    recordAgentDispatchCompleted?: boolean;
    sessionMetadataChanges?: DispatchFromConfigResult["sessionMetadataChanges"];
  }): DispatchFromConfigResult => {
    void state.releasePreDispatchLifecycleAdmission(() => waitForReplyDispatcherIdle(dispatcher));
    if (opts?.recordAgentDispatchCompleted) {
      recordAgentDispatchCompleted("completed", { reason: "reply-operation-active" });
    }
    recordProcessed("skipped", { reason: "reply-operation-active" });
    markIdle("message_completed");
    if (opts?.dedupeDisposition === "release") {
      releaseInboundDedupeIfClaimed();
    } else {
      commitInboundDedupeIfClaimed();
    }
    return attachSourceReplyDeliveryMode({
      ...baseDispatchResult(),
      ...(opts?.sessionMetadataChanges
        ? { sessionMetadataChanges: opts.sessionMetadataChanges }
        : {}),
    });
  };
  const finishReplyOperationAbortedDispatch = (): DispatchFromConfigResult => {
    const operation = state.getDispatchReplyOperation();
    recordReplyOperationAgentTurn([state.replyOperationRunState], operation);
    // Feedback only for pre-run drops: the user never saw output. Finalization or
    // terminal-settle stalls already produced/settled output, so a notice is noise.
    // Last resort: an armed run owner first hands the request to the follow-up lane.
    const queuedFinal =
      isReplyOperationStalledBeforeOutput(operation) &&
      state.replyOperationRunState.continueStalledTurn?.() !== true
        ? dispatcher.sendFinalReply({ text: STALLED_TURN_NOTICE_TEXT, isError: true })
        : false;
    if (
      state.turnAdoptionState &&
      !state.turnAdoptionState.adopted &&
      !state.inboundDedupeReplayUnsafe
    ) {
      releaseInboundDedupeIfClaimed();
    } else {
      commitInboundDedupeIfClaimed();
    }
    recordProcessed("skipped", { reason: "reply_operation_aborted" });
    markIdle("message_completed");
    state.completeDispatchReplyOperation();
    return attachSourceReplyDeliveryMode({
      ...baseDispatchResult(queuedFinal),
      ...(state.turnLedger.hasObservedDelivery() ? { observedReplyDelivery: true } : {}),
    });
  };

  const bindingState: {
    pluginFallbackReason?:
      | "plugin-bound-fallback-missing-plugin"
      | "plugin-bound-fallback-no-handler";
  } = {};
  const emitMessageReceivedHooks = () => {
    if (!state.allowInboundHandlers) {
      return;
    }
    emitSharedMessageReceivedHooks({
      ctx,
      hookRunner,
      sessionKey,
      timestamp: state.timestamp,
      buildContext: buildMessageReceivedHookContext,
    });
  };
  state.markProcessing();
  if (state.allowInboundHandlers && (await capturePendingConversationTurnReply({ cfg, ctx }))) {
    emitMessageReceivedHooks();
    commitInboundDedupeIfClaimed();
    recordProcessed("completed", { reason: "conversation-turn-reply" });
    markIdle("message_completed");
    return {
      status: "complete" as const,
      result: attachSourceReplyDeliveryMode({
        ...baseDispatchResult(),
        observedReplyDelivery: true,
      }),
    };
  }
  const nextState = Object.assign(state, {
    sendBindingNotice,
    pluginOwnedBinding,
    pluginBindingSessionKey,
    pluginBindingTargetKind,
    persistPluginBindingUserTurn,
    sendPolicy,
    chatType,
    sourceReplyPolicy,
    sourceReplyDeliveryRuntimeOptions,
    ...sourceReplyPolicy,
    reasoningPayloadsEnabled,
    commentaryPayloadsEnabled,
    attachSourceReplyDeliveryMode,
    explicitCommandTurnCtx,
    activeRunSafeCommandTurn,
    shouldDeliverPluginBindingReply,
    inboundDedupeClaim,
    commitInboundDedupeIfClaimed,
    finishReplyOperationBusyDispatch,
    finishReplyOperationAbortedDispatch,
    emitMessageReceivedHooks,
    bindingState,
  });
  return { status: "ready" as const, state: nextState };
}

type PrepareDispatchOperationContextResult = Awaited<
  ReturnType<typeof prepareDispatchOperationContext>
>;
export type PrepareDispatchOperationContextReadyState = Extract<
  PrepareDispatchOperationContextResult,
  { status: "ready" }
>["state"];

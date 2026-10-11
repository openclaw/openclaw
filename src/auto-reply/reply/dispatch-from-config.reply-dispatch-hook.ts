import { withClaimingHookAdmission } from "../../plugins/hook-claim-admission.js";
import { createPluginSubagentRequesterContext } from "../../plugins/runtime/subagent-requester-context.js";
import type { ReplyPayload } from "../reply-payload.js";
import { runWithDispatchAbortSignal } from "./dispatch-from-config.abort.js";
import {
  admittedSessionSettingsRestrictRuntime,
  createReplyDispatchEvent,
} from "./dispatch-from-config.events.js";
import type { PrepareDispatchOperationReadyState } from "./dispatch-from-config.prepare-operation.js";

export function runReplyDispatchHook(
  state: PrepareDispatchOperationReadyState,
  options: {
    shouldSendToolSummaries: () => boolean;
    shouldSendToolSummariesAsync: () => Promise<boolean>;
    isTailDispatch?: true;
  },
) {
  const { hookRunner, params } = state;
  if (
    !state.allowInboundHandlers ||
    admittedSessionSettingsRestrictRuntime(params.replyOptions?.admittedSessionSettings) ||
    !hookRunner?.hasHooks("reply_dispatch", { dispatchKind: state.dispatchKind })
  ) {
    return undefined;
  }
  const run = () =>
    state.runWithDispatchLifecycleAdmission(async () => {
      return await runWithDispatchAbortSignal(
        // Reset tails have entered dispatch admission; initial takeover still owns the pre-dispatch lease.
        options.isTailDispatch ? state.getDispatchAbortSignal() : state.getPreDispatchAbortSignal(),
        async () => {
          const shouldSendFullToolDetails = await state.shouldEmitFullVerboseProgressAsync();
          state.assertProgressCurrent();
          return hookRunner.runReplyDispatch(
            createReplyDispatchEvent({
              ctx: state.ctx,
              runId: params.replyOptions?.runId,
              sessionKey: state.acpDispatchSessionKey,
              toolsAllow: params.replyOptions?.toolsAllow,
              images: params.replyOptions?.images,
              inboundAudio: state.inboundAudio,
              sessionTtsAuto: state.sessionTtsAuto,
              ttsChannel: state.deliveryChannel,
              suppressUserDelivery: state.suppressHookUserDelivery,
              suppressReplyLifecycle: state.suppressHookReplyLifecycle,
              sourceReplyDeliveryMode: state.sourceReplyDeliveryMode,
              shouldRouteToOriginating: state.shouldRouteToOriginating,
              originatingChannel: state.routeReplyChannel,
              originatingTo: state.routeReplyTo,
              originatingAccountId: state.replyContextAccountId,
              originatingThreadId: state.routeReplyThreadId,
              originatingChatType: state.replyRoute.chatType,
              shouldSendToolSummaries: options.shouldSendToolSummaries,
              shouldSendToolSummariesAsync: options.shouldSendToolSummariesAsync,
              shouldSendFullToolDetails,
              shouldSendFullToolDetailsAsync: state.shouldEmitFullVerboseProgressAsync,
              sendPolicy: state.sendPolicy,
              ...(options.isTailDispatch ? { isTailDispatch: true } : {}),
            }),
            withClaimingHookAdmission(
              {
                cfg: state.cfg,
                dispatchKind: state.dispatchKind,
                dispatcher: state.dispatchHookDispatcher,
                abortSignal: state.getPreDispatchAbortSignal() ?? params.replyOptions?.abortSignal,
                onReplyStart: params.replyOptions?.onReplyStart,
                onAgentRunStart: params.replyOptions?.onAgentRunStart,
                userTurnTranscriptRecorder: params.replyOptions?.userTurnTranscriptRecorder,
                prepareAssistantTranscriptMessage:
                  params.replyOptions?.prepareAssistantTranscriptMessage,
                recordProcessed: state.recordProcessed,
                markIdle: state.markIdle,
              },
              options.isTailDispatch ? undefined : { prepare: state.assertCurrentBindingRoute },
            ),
          );
        },
        state.trackDispatchLifecycleWork,
      );
    });
  return options.isTailDispatch ? run() : state.traceReplyPhase("reply.reply_dispatch_hooks", run);
}

type BeforeDispatchTakeover = {
  payload: ReplyPayload;
  deliveryId: string;
  recordProcessed: () => void;
};

export function prepareBeforeDispatchTakeover(state: PrepareDispatchOperationReadyState) {
  const {
    getPreDispatchAbortSignal,
    hookRunner,
    params,
    recordProcessed,
    replyContextAccountId,
    routeReplyChannel,
    routeReplyThreadId,
    routeReplyTo,
    runWithDispatchLifecycleAdmission,
    sessionKey,
    sessionStoreEntry,
    traceReplyPhase,
    trackDispatchLifecycleWork,
  } = state;
  if (
    !state.allowInboundHandlers ||
    admittedSessionSettingsRestrictRuntime(params.replyOptions?.admittedSessionSettings) ||
    !hookRunner?.hasHooks("before_dispatch")
  ) {
    return undefined;
  }
  // This outer lookup key is resolved from the routed context; fields inside
  // sessionStoreEntry.entry cannot redirect hook or requester lineage.
  const beforeDispatchSessionKey = sessionStoreEntry.sessionKey ?? sessionKey;
  const pluginSubagentRequester = createPluginSubagentRequesterContext({
    sessionKey: beforeDispatchSessionKey,
    origin: {
      channel: routeReplyChannel,
      to: routeReplyTo,
      accountId: replyContextAccountId,
      threadId: routeReplyThreadId,
    },
  });
  return traceReplyPhase("reply.before_dispatch_hooks", () =>
    runWithDispatchLifecycleAdmission(async () => {
      return await runWithDispatchAbortSignal(
        getPreDispatchAbortSignal(),
        () => {
          const hookContext = state.hookState.hookContext;
          const replyContext = {
            messageId: hookContext.messageId,
            sessionKey: beforeDispatchSessionKey,
            senderId: hookContext.senderId,
            replyToId: hookContext.replyToId,
            replyToIdFull: hookContext.replyToIdFull,
            replyToBody: hookContext.replyToBody,
            replyToSender: hookContext.replyToSender,
            replyToIsQuote: hookContext.replyToIsQuote,
          };
          return hookRunner.runBeforeDispatch(
            {
              ...replyContext,
              content: hookContext.content,
              body: hookContext.bodyForAgent ?? hookContext.body,
              channel: hookContext.channelId,
              isGroup: hookContext.isGroup,
              timestamp: hookContext.timestamp,
            },
            withClaimingHookAdmission(
              {
                ...replyContext,
                channelId: hookContext.channelId,
                accountId: hookContext.accountId,
                conversationId: state.hookState.inboundClaimContext.conversationId,
              },
              { prepare: state.assertCurrentBindingRoute },
            ),
            pluginSubagentRequester,
          );
        },
        trackDispatchLifecycleWork,
      );
    }),
  ).then((result): BeforeDispatchTakeover | undefined => {
    if (!result?.handled) {
      return undefined;
    }
    return {
      payload: { text: result.text },
      deliveryId: "before-dispatch",
      recordProcessed: () => recordProcessed("completed", { reason: "before_dispatch_handled" }),
    };
  });
}

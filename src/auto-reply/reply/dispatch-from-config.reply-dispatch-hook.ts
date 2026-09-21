import type { ReplyPayload } from "../types.js";
import { shouldBypassAcpDispatchForCommand } from "./dispatch-acp-command-bypass.js";
import {
  DispatchReplyOperationAbortedError,
  runWithDispatchAbortSignal,
} from "./dispatch-from-config.abort.js";
import { createReplyDispatchEvent } from "./dispatch-from-config.events.js";
import type { PrepareDispatchOperationReadyState } from "./dispatch-from-config.prepare-operation.js";
import { runtimeTakeoverHooksAllowed } from "./dispatch-from-config.restricted-runtime.js";
import type { DispatchFromConfigResult } from "./dispatch-from-config.types.js";

type SendFinalPayload = (
  payload: ReplyPayload,
  options: { abortSignal?: AbortSignal; deliveryId: string },
) => Promise<{ queuedFinal: boolean; routedFinalCount: number }>;

export async function runReplyDispatchHook(
  state: PrepareDispatchOperationReadyState,
  options: {
    shouldSendToolSummaries: () => boolean;
    isTailDispatch?: true;
    sendFinalPayload: SendFinalPayload;
  },
) {
  const { hookRunner, params } = state;
  if (
    !state.allowInboundHandlers ||
    !runtimeTakeoverHooksAllowed(params.replyOptions?.admittedSessionSettings) ||
    !hookRunner?.hasHooks("reply_dispatch", { dispatchKind: state.dispatchKind })
  ) {
    return undefined;
  }
  const run = () =>
    state.runWithDispatchLifecycleAdmission(
      async () =>
        await runWithDispatchAbortSignal(
          // Reset tails have entered dispatch admission; initial takeover still owns the pre-dispatch lease.
          options.isTailDispatch
            ? state.getDispatchAbortSignal()
            : state.getPreDispatchAbortSignal(),
          () =>
            hookRunner.runReplyDispatchOutcome(
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
                shouldSendFullToolDetails: state.shouldEmitFullVerboseProgress(),
                sendPolicy: state.sendPolicy,
                ...(options.isTailDispatch ? { isTailDispatch: true } : {}),
              }),
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
            ),
          state.trackDispatchLifecycleWork,
        ),
    );
  const outcome = await (options.isTailDispatch
    ? run()
    : state.traceReplyPhase("reply.reply_dispatch_hooks", run));
  const result = outcome.status === "handled" ? outcome.result : undefined;
  if (
    result?.handled ||
    state.dispatchKind !== "acp" ||
    (!options.isTailDispatch && shouldBypassAcpDispatchForCommand(state.ctx, state.cfg)) ||
    outcome.status !== "error"
  ) {
    return result;
  }

  // A failed hook can already have started ACP work. Its error does not authorize
  // replaying the same prompt through the ordinary model runtime.
  const abortSignal = options.isTailDispatch
    ? state.getDispatchAbortSignal()
    : state.getPreDispatchAbortSignal();
  if (abortSignal?.aborted) {
    throw new DispatchReplyOperationAbortedError();
  }
  state.markInboundDedupeReplayUnsafe();
  const text =
    "The ACP turn did not complete. It was not retried with another runtime. Check any existing results before trying again.";
  const before = state.dispatcher.getQueuedCounts();
  const notice =
    state.suppressHookUserDelivery || before.final > 0
      ? { queuedFinal: false, routedFinalCount: 0 }
      : await options.sendFinalPayload(
          { text, isError: true },
          { abortSignal, deliveryId: "acp-dispatch-unclaimed" },
        );
  const counts = state.dispatcher.getQueuedCounts();
  counts.final += notice.routedFinalCount;
  state.recordProcessed("error", { reason: "acp_dispatch_unclaimed", error: text });
  state.markIdle("message_completed");
  return { handled: true, queuedFinal: notice.queuedFinal || counts.final > 0, counts };
}

export async function runReplyDispatchTakeover(
  state: PrepareDispatchOperationReadyState,
  shouldSendToolSummaries: () => boolean,
  sendFinalPayload: SendFinalPayload,
): Promise<{ status: "complete"; result: DispatchFromConfigResult } | undefined> {
  const result = await runReplyDispatchHook(state, { shouldSendToolSummaries, sendFinalPayload });
  if (!result?.handled) {
    return undefined;
  }
  state.commitInboundDedupeIfClaimed();
  state.completeDispatchReplyOperation();
  return {
    status: "complete",
    result: state.attachSourceReplyDeliveryMode({
      queuedFinal: result.queuedFinal,
      counts: result.counts,
    }),
  };
}

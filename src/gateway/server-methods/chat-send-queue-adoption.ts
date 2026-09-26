import type { InternalGetReplyOptions } from "../../auto-reply/reply/get-reply.types.js";
import { resolveQueueSettingsCore } from "../../auto-reply/reply/queue/settings.js";
import type { StartChatDispatchParams } from "./chat-send-agent-dispatch.types.js";
import { finalizeAcceptedChatSendMessageInjection } from "./chat-send-message-injection.js";

/** Final routing fence for already-prepared dispatch; never replay its side effects. */
export function createChatSendQueueAdoption(
  params: StartChatDispatchParams,
  onInjected: () => void,
): InternalGetReplyOptions["adoptFollowupQueue"] {
  const { admission, request, injection, session, context, turn, userTurn } = params;
  if (!admission.autoSteerTarget || !params.revalidateRouting) {
    return undefined;
  }
  const mayNeedLateInjection =
    request.autoSteer?.reason === "decision" && request.autoSteer.choice === "followup";
  return async (enqueue) => {
    params.revalidateRouting?.();
    const target = admission.messageInjectionTarget;
    // Advice can expire during preparation. Try only the original target, once;
    // a previously rejected injection must proceed to ordinary fallback custody.
    if (mayNeedLateInjection && target && !injection.messageInjectionAttempt) {
      injection.messageInjectionAttempt = injection.beginCapturedMessageInjection();
      if (
        injection.messageInjectionAttempt &&
        (await finalizeAcceptedChatSendMessageInjection({
          attempt: injection.messageInjectionAttempt,
          sessionBinding: admission.sessionBinding,
          context,
          ctx: turn.ctx,
          persistUserTurnTranscriptBestEffort: async () => {
            await userTurn.persistBestEffort();
          },
          session,
          startedAt: params.admissionStartedAt,
          target,
          dispatchOwnsMessageLifecycle: true,
        }))
      ) {
        onInjected();
        return "steered";
      }
    }
    params.revalidateRouting?.();
    const mode = resolveQueueSettingsCore({
      cfg: context.getRuntimeConfig(),
      channel: turn.ctx.Provider,
      sessionEntry: session.entry,
      inlineMode: request.resolvedQueueMode ?? request.p.queueMode,
    }).mode;
    // No await between live validation, onDeferred, and queue publication.
    return enqueue(mode) ? "queued" : "skipped";
  };
}

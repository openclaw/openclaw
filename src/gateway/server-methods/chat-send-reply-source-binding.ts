import type { StartChatDispatchParams } from "./chat-send-agent-dispatch.types.js";

/** The original active/queued work owner supplies the current SID, without another row read. */
export function readChatSendReplySourceSessionId(
  params: Pick<StartChatDispatchParams, "admission" | "context" | "session" | "userTurn">,
): string | undefined {
  const { admission, context, session, userTurn } = params;
  try {
    admission.assertWorkAdmissionCurrent();
    if (!userTurn.replySource.isCurrent()) {
      return undefined;
    }
    const queued = context.chatQueuedTurns.get(session.clientRunId);
    if (
      context.chatAbortControllers.get(session.clientRunId) !== admission.activeRunAbort.entry &&
      queued?.controller !== admission.activeRunAbort.controller
    ) {
      return undefined;
    }
    return admission.sessionBinding.sessionId;
  } catch {
    return undefined;
  }
}

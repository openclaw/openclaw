import type { ReplyPayload } from "../reply-payload.js";

export const EMPTY_FINAL_REPLY_TEXT =
  "⚠️ The run finished without a visible reply. Please retry, or check the session logs if this repeats.";

type BuildEmptyFinalReplyPayloadParams = {
  isHeartbeat: boolean;
  silentExpected?: boolean;
  hasVisibleBlockReply?: boolean;
  hasMessagingToolSend?: boolean;
};

export function buildEmptyFinalReplyPayload(
  params: BuildEmptyFinalReplyPayloadParams,
): ReplyPayload | undefined {
  if (
    params.isHeartbeat ||
    params.silentExpected === true ||
    params.hasVisibleBlockReply === true ||
    params.hasMessagingToolSend === true
  ) {
    return undefined;
  }
  return { text: EMPTY_FINAL_REPLY_TEXT, isError: true };
}

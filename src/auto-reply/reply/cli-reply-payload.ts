import { setReplyPayloadMetadata, type ReplyPayload } from "../reply-payload.js";
import { parseReplyDirectives } from "./reply-directives.js";

export function prepareCliReplyPayload(
  text: string,
  currentMessageId?: string,
  assistantMessageIndex?: number,
): ReplyPayload {
  const parsed = parseReplyDirectives(text, { currentMessageId });
  const reply: ReplyPayload = {
    text: parsed.text,
    mediaUrls: parsed.mediaUrls,
    replyToId: parsed.replyToId,
    replyToCurrent: parsed.replyToCurrent,
    ...(parsed.replyToTag ? { replyToTag: true } : {}),
    audioAsVoice: parsed.audioAsVoice,
  };
  if (assistantMessageIndex !== undefined) {
    setReplyPayloadMetadata(reply, { assistantMessageIndex });
  }
  if (parsed.isSilent) {
    setReplyPayloadMetadata(reply, { silentReply: true });
  }
  return reply;
}

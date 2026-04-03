import { hasInteractiveReplyBlocks, hasReplyChannelData } from "../../interactive/payload.js";
import type { ReplyPayload } from "../types.js";

/**
 * Returns true if a final reply payload carries non-text visible content
 * that should be delivered even when replyMode is "tool-only".
 *
 * Tool-only mode suppresses plain-text assistant narration to prevent
 * leakage in shared sessions, but media, errors, interactive elements,
 * and channelData payloads are legitimate user-visible output.
 */
export function isNonTextVisibleFinal(payload: ReplyPayload): boolean {
  const hasMedia = Boolean(payload.mediaUrl || payload.mediaUrls?.length);
  const isError = Boolean(payload.isError);
  const hasInteractive = hasInteractiveReplyBlocks(payload.interactive);
  const hasChannelData = hasReplyChannelData(payload.channelData);
  return hasMedia || isError || hasInteractive || hasChannelData;
}

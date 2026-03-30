export {
  applyReplyTagsToPayload,
  applyReplyThreading,
  formatBtwTextForExternalDelivery,
  isRenderablePayload,
  shouldSuppressReasoningPayload,
} from "./reply-payloads-base.js";
export {
  filterMessagingToolDuplicates,
  filterMessagingToolMediaDuplicates,
  shouldSuppressMessagingToolReplies,
} from "./reply-payloads-dedupe.js";
import type { ReplyPayload } from "../types.js";
import { parseReplyDirectives } from "./reply-directives.js";

function extractToolDeliveryMediaUrls(payload: ReplyPayload): string[] {
  const mediaUrls = payload.mediaUrls ?? [];
  const mediaUrl = payload.mediaUrl ? [payload.mediaUrl] : [];
  const parsed = payload.text ? parseReplyDirectives(payload.text) : undefined;
  const textMediaUrls = parsed?.mediaUrls ?? [];
  const seen = new Set<string>();
  for (const url of [...mediaUrls, ...mediaUrl, ...textMediaUrls]) {
    if (!url || seen.has(url)) {
      continue;
    }
    seen.add(url);
  }
  return [...seen];
}

export function resolveToolDeliveryPayload(
  payload: ReplyPayload,
  options?: { allowText?: boolean; allowExecApproval?: boolean },
): ReplyPayload | null {
  const allowText = options?.allowText === true;
  const allowExecApproval = options?.allowExecApproval !== false;
  if (allowText && payload.text?.trim()) {
    return payload;
  }
  const execApproval =
    payload.channelData &&
    typeof payload.channelData === "object" &&
    !Array.isArray(payload.channelData)
      ? payload.channelData.execApproval
      : undefined;
  if (
    allowExecApproval &&
    execApproval &&
    typeof execApproval === "object" &&
    !Array.isArray(execApproval)
  ) {
    return payload;
  }
  const mediaUrls = extractToolDeliveryMediaUrls(payload);
  const hasMedia = mediaUrls.length > 0;
  if (!hasMedia) {
    return null;
  }
  return {
    ...payload,
    text: undefined,
    mediaUrls,
    mediaUrl: mediaUrls[0],
  };
}

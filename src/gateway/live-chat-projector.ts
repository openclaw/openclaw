import { stripInternalRuntimeContext } from "../agents/internal-runtime-context.js";
import {
  SILENT_REPLY_TOKEN,
  startsWithSilentToken,
  stripLeadingSilentToken,
} from "../auto-reply/tokens.js";
import { resolveAssistantEventPhase } from "../shared/chat-message-content.js";
import { stripInlineDirectiveTagsForDisplay } from "../utils/directive-tags.js";
import {
  isSuppressedControlReplyLeadFragment,
  isSuppressedControlReplyText,
} from "./control-reply-text.js";

export const MAX_LIVE_CHAT_BUFFER_CHARS = 500_000;

function capLiveAssistantBuffer(text: string): string {
  if (text.length <= MAX_LIVE_CHAT_BUFFER_CHARS) {
    return text;
  }
  // Keep the newest text because live chat recovery is for the visible tail, not transcript
  // archival; persisted history remains the source of truth for the full response.
  return text.slice(-MAX_LIVE_CHAT_BUFFER_CHARS);
}

/** Merges assistant snapshots and deltas into one bounded live-chat buffer. */
export function resolveMergedAssistantText(params: {
  previousText: string;
  nextText: string;
  nextDelta: string;
}): string {
  const { previousText, nextText, nextDelta } = params;
  if (nextText && previousText) {
    if (nextText.startsWith(previousText) && nextText.length > previousText.length) {
      return capLiveAssistantBuffer(nextText);
    }
    if (previousText.startsWith(nextText) && !nextDelta) {
      // Providers can resend a shorter snapshot after a fuller one; without a delta, keep the
      // longer buffer so live UI does not flicker backward.
      return capLiveAssistantBuffer(previousText);
    }
  }
  if (nextDelta) {
    return capLiveAssistantBuffer(previousText + nextDelta);
  }
  if (nextText) {
    return capLiveAssistantBuffer(nextText);
  }
  return capLiveAssistantBuffer(previousText);
}

/** Removes runtime-only metadata and directive tags from assistant event text/deltas. */
export function normalizeLiveAssistantEventText(params: { text: string; delta?: unknown }): {
  text: string;
  delta: string;
} {
  return {
    text: stripInternalRuntimeContext(stripInlineDirectiveTagsForDisplay(params.text).text),
    delta:
      typeof params.delta === "string"
        ? stripInternalRuntimeContext(stripInlineDirectiveTagsForDisplay(params.delta).text)
        : "",
  };
}

/** Projects buffered assistant text into the user-visible live chat form. */
export function projectLiveAssistantBufferedText(
  rawText: string,
  options?: { suppressLeadFragments?: boolean },
): {
  text: string;
  suppress: boolean;
  pendingLeadFragment: boolean;
} {
  if (!rawText) {
    return { text: "", suppress: true, pendingLeadFragment: false };
  }
  if (isSuppressedControlReplyText(rawText)) {
    return { text: "", suppress: true, pendingLeadFragment: false };
  }
  if (options?.suppressLeadFragments !== false && isSuppressedControlReplyLeadFragment(rawText)) {
    // Hold partial control-reply prefixes until enough text arrives to prove whether they should
    // be hidden entirely or rendered as ordinary assistant output.
    return { text: rawText, suppress: true, pendingLeadFragment: true };
  }
  const text = startsWithSilentToken(rawText, SILENT_REPLY_TOKEN)
    ? stripLeadingSilentToken(rawText, SILENT_REPLY_TOKEN)
    : rawText;
  if (!text || isSuppressedControlReplyText(text)) {
    return { text: "", suppress: true, pendingLeadFragment: false };
  }
  if (options?.suppressLeadFragments !== false && isSuppressedControlReplyLeadFragment(text)) {
    return { text, suppress: true, pendingLeadFragment: true };
  }
  return { text, suppress: false, pendingLeadFragment: false };
}

/** Filters assistant commentary events out of live chat while allowing final transcript storage. */
export function shouldSuppressAssistantEventForLiveChat(data: unknown): boolean {
  return resolveAssistantEventPhase(data) === "commentary";
}

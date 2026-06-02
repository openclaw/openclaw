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
  return text.slice(-MAX_LIVE_CHAT_BUFFER_CHARS);
}

/** Merges cumulative snapshots and incremental deltas into one bounded live-chat buffer. */
export function resolveMergedAssistantText(params: {
  previousText: string;
  nextText: string;
  nextDelta: string;
}): string {
  const { previousText, nextText, nextDelta } = params;
  if (nextText && previousText) {
    // Some runtimes send cumulative snapshots while others send pure deltas.
    // Prefer a longer prefix snapshot, but never collapse repeated delta text
    // such as "111" or markdown separators.
    if (nextText.startsWith(previousText) && nextText.length > previousText.length) {
      return capLiveAssistantBuffer(nextText);
    }
    if (previousText.startsWith(nextText) && !nextDelta) {
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

/** Strips internal runtime/directive markers from assistant event text before UI projection. */
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

/** Projects buffered assistant text into displayable live-chat text plus suppression state. */
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
    // Keep a possible leading control token hidden until enough bytes arrive to
    // prove whether it is a full silent reply or ordinary assistant text.
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

/** Keeps commentary-phase assistant events out of the end-user live chat transcript. */
export function shouldSuppressAssistantEventForLiveChat(data: unknown): boolean {
  return resolveAssistantEventPhase(data) === "commentary";
}

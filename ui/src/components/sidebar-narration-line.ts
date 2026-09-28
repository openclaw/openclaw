import { flattenMarkdownToPlainText } from "@openclaw/normalization-core/markdown-plain-text";
import { stripInternalRuntimeContext } from "../../../src/agents/internal-runtime-context.js";
import {
  isSuppressedControlReplyLeadFragment,
  isSuppressedControlReplyText,
  stripSuppressedControlReplyToken,
} from "../../../src/gateway/control-reply-text.js";
import { stripInlineDirectiveTagsForDisplay } from "../../../src/utils/directive-tags.js";
import { stripHeartbeatTokenForDisplay } from "../lib/chat/heartbeat-display.ts";
import { clampText } from "../lib/format.ts";

const SIDEBAR_NARRATION_MAX_LENGTH = 120;

// TRANSITIONAL(marker-retirement): live narration strips inline markers because
// streamed drafts still carry them mid-run; persisted data is already clean.
// Drop the stripInlineDirectiveTagsForDisplay call when the visibleReplies
// default flips to "message_tool".
function normalizeSidebarNarrationText(text: string): string | null {
  const displayText = stripSuppressedControlReplyToken(
    stripInternalRuntimeContext(stripInlineDirectiveTagsForDisplay(text).text),
  );
  const heartbeat = stripHeartbeatTokenForDisplay(displayText);
  if (
    !displayText ||
    isSuppressedControlReplyText(displayText) ||
    isSuppressedControlReplyLeadFragment(displayText) ||
    heartbeat.shouldSkip
  ) {
    return null;
  }
  return heartbeat.text;
}

/** Compact the newest prose into one quiet, stable sidebar line. */
export function deriveSidebarNarrationLine(text: string): string {
  const displayText = normalizeSidebarNarrationText(text);
  if (!displayText) {
    return "";
  }
  // Fences are dropped before the paragraph split, not just by the shared
  // flattener: a fenced block contains blank lines, so splitting first would
  // let code fragments become the "newest paragraph" and win the line.
  const paragraphs = displayText.replace(/```[\s\S]*?```/g, " ").split(/\n\s*\n/);
  let paragraph = "";
  for (let index = paragraphs.length - 1; index >= 0; index -= 1) {
    paragraph = flattenMarkdownToPlainText(paragraphs[index] ?? "");
    if (paragraph) {
      break;
    }
  }
  if (!paragraph) {
    return "";
  }
  const fragments = paragraph.match(/[^.!?…]+(?:[.!?…]+(?=\s|$)|$)/g);
  const newest =
    fragments?.map((fragment) => fragment.trim()).findLast((fragment) => Boolean(fragment)) ??
    paragraph;
  return clampText(newest, SIDEBAR_NARRATION_MAX_LENGTH);
}

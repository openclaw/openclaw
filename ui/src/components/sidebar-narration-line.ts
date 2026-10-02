import { flattenMarkdownToPlainText } from "@openclaw/normalization-core/markdown-plain-text";
import {
  INTERNAL_RUNTIME_CONTEXT_BEGIN,
  INTERNAL_RUNTIME_CONTEXT_END,
  stripInternalRuntimeContext,
} from "../../../src/agents/internal-runtime-context.js";
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

function trailingInternalDelimiterPrefix(text: string): string {
  const tokens = [INTERNAL_RUNTIME_CONTEXT_BEGIN, INTERNAL_RUNTIME_CONTEXT_END];
  for (
    let length = Math.min(text.length, ...tokens.map((token) => token.length - 1));
    length >= 1;
    length -= 1
  ) {
    const suffix = text.slice(-length);
    if (tokens.some((token) => token.startsWith(suffix))) {
      return suffix;
    }
  }
  return "";
}

export function stripSidebarInternalRuntimeFragment(
  stream: { internalDepth: number; delimiterTail: string },
  fragment: string,
): string {
  const text = `${stream.delimiterTail}${fragment}`;
  stream.delimiterTail = "";
  let depth = stream.internalDepth;
  let cursor = 0;
  let visible = "";

  while (cursor < text.length) {
    const nextBegin = text.indexOf(INTERNAL_RUNTIME_CONTEXT_BEGIN, cursor);
    const nextEnd = text.indexOf(INTERNAL_RUNTIME_CONTEXT_END, cursor);
    if (depth === 0) {
      if (nextBegin === -1 && nextEnd === -1) {
        visible += text.slice(cursor);
        break;
      }
      if (nextEnd !== -1 && (nextBegin === -1 || nextEnd < nextBegin)) {
        // A stray closing delimiter means this fragment may start inside an
        // already-trimmed block. Fail closed until that boundary passes.
        cursor = nextEnd + INTERNAL_RUNTIME_CONTEXT_END.length;
        continue;
      }
      visible += text.slice(cursor, nextBegin);
      depth = 1;
      cursor = nextBegin + INTERNAL_RUNTIME_CONTEXT_BEGIN.length;
      continue;
    }
    if (nextBegin === -1 && nextEnd === -1) {
      break;
    }
    if (nextBegin !== -1 && (nextEnd === -1 || nextBegin < nextEnd)) {
      depth += 1;
      cursor = nextBegin + INTERNAL_RUNTIME_CONTEXT_BEGIN.length;
      continue;
    }
    depth -= 1;
    cursor = nextEnd + INTERNAL_RUNTIME_CONTEXT_END.length;
  }

  const delimiterPrefix = trailingInternalDelimiterPrefix(text);
  if (delimiterPrefix) {
    stream.delimiterTail = delimiterPrefix;
    if (depth === 0 && visible.endsWith(delimiterPrefix)) {
      visible = visible.slice(0, -delimiterPrefix.length);
    }
  }
  stream.internalDepth = depth;
  return visible;
}

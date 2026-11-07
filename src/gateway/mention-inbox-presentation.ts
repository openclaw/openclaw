import { flattenMarkdownToPlainText } from "@openclaw/normalization-core/markdown-plain-text";
import { err, type Result } from "@openclaw/normalization-core/result";
import { sliceUtf16Safe, truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import {
  ErrorCodes,
  errorShape,
  type ErrorShape,
} from "../../packages/gateway-protocol/src/index.js";
import type { SessionEntry } from "../config/sessions.js";
import type { SubsystemLogger } from "../logging/subsystem.js";
import { deriveSessionTitle } from "./session-utils-core.js";

export function formatMentionSessionTitle(entry: SessionEntry | undefined): string {
  return (
    truncateUtf16Safe(
      (deriveSessionTitle(entry) ?? "Conversation")
        .replace(/[\p{Cc}\p{Cf}]/gu, " ")
        .replace(/\s+/gu, " ")
        .trim(),
      256,
    ) || "Conversation"
  );
}

const MENTION_EXCERPT_MAX = 280;
const MENTION_CONTEXT_SOURCE_MAX = 1_024;
const MENTION_PLACEHOLDER = "Q9openclawmention9Q";

function plainMentionText(text: string): string {
  return flattenMarkdownToPlainText(text)
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

export function formatMentionExcerpt(excerpt: string | undefined): string | undefined {
  return excerpt
    ? truncateUtf16Safe(plainMentionText(truncateUtf16Safe(excerpt, 2_048)), MENTION_EXCERPT_MAX)
    : undefined;
}

export type MentionPreview = { excerpt: string; start: number; end: number };

/** Wire fields for a stored recipient preview; legacy items keep their shared excerpt. */
export function projectMentionPreview(preview: MentionPreview | undefined) {
  return preview
    ? { excerpt: preview.excerpt, excerptHighlight: { start: preview.start, end: preview.end } }
    : {};
}

function fitContext(value: string, limit: number, more: boolean, side: "before" | "after") {
  if (!more && value.length <= limit) {
    return value;
  }
  if (limit <= 1) {
    return "";
  }
  return side === "after"
    ? `${truncateUtf16Safe(value, limit - 1).trimEnd()}…`
    : `…${sliceUtf16Safe(value, -(limit - 1)).trimStart()}`;
}

/**
 * Plain-text excerpt centered on one selected mention. Each side is flattened separately so
 * `start`/`end` stay exact UTF-16 offsets of the selected label inside `excerpt`.
 */
export function formatMentionPreview(
  text: string,
  span: { start: number; end: number },
): MentionPreview | undefined {
  const label = truncateUtf16Safe(
    sliceUtf16Safe(text, span.start, span.end)
      .replace(/[\p{Cc}\p{Cf}\s]+/gu, " ")
      .trim(),
    80,
  );
  if (!label) {
    return undefined;
  }
  const contextStart = Math.max(0, span.start - MENTION_CONTEXT_SOURCE_MAX);
  const contextEnd = span.end + MENTION_CONTEXT_SOURCE_MAX;
  // Flatten once around a plain placeholder so Markdown wrapping the mention (`**@Sam**`)
  // is removed like any other; private-use characters would be stripped by the flattener.
  const parts = plainMentionText(
    `${sliceUtf16Safe(text, contextStart, span.start)}${MENTION_PLACEHOLDER}${sliceUtf16Safe(text, span.end, contextEnd)}`,
  ).split(MENTION_PLACEHOLDER);
  if (parts.length !== 2) {
    return undefined;
  }
  let [before = "", after = ""] = parts;
  const room = MENTION_EXCERPT_MAX - label.length;
  after = fitContext(
    after,
    Math.max(Math.ceil(room / 2), room - before.length),
    contextEnd < text.length,
    "after",
  );
  before = fitContext(before, room - after.length, contextStart > 0, "before");
  return {
    excerpt: `${before}${label}${after}`,
    start: before.length,
    end: before.length + label.length,
  };
}

export function mentionInboxUnavailable(
  log?: Pick<SubsystemLogger, "warn">,
): Result<never, ErrorShape> {
  log?.warn("The mention Inbox could not read or save its current state. Reconnect to retry.");
  return err(
    errorShape(ErrorCodes.UNAVAILABLE, "The mention Inbox is unavailable. Reconnect to retry.", {
      retryable: true,
    }),
  );
}

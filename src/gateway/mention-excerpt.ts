import { flattenMarkdownToPlainText } from "@openclaw/normalization-core/markdown-plain-text";
import { sliceUtf16Safe, truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { HumanMention } from "../../packages/gateway-protocol/src/index.js";

type PreparedMentionExcerpt = {
  profileId: string;
  excerpt: string;
  excerptMention: { start: number; end: number };
};

const MAX_EXCERPT = 280;
const BEFORE_MENTION = 32;
const SOURCE_CONTEXT = 1_024;

function clean(text: string): string {
  return text
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

/** Prepare display-only spans from admitted selections, never from matching @names. */
export function prepareMentionExcerpts(
  text: string,
  mentions: readonly HumanMention[],
  redact: (text: string) => string,
): { fallback: string; recipients: PreparedMentionExcerpt[] } {
  const redacted = redact(text);
  const fallback = truncateUtf16Safe(
    clean(flattenMarkdownToPlainText(truncateUtf16Safe(redacted, 2_048))),
    MAX_EXCERPT,
  );
  if (mentions.length === 0) {
    return { fallback, recipients: [] };
  }
  let serial = 0;
  let prefix: string;
  do {
    prefix = `openclawmention${serial++}x`;
  } while (text.includes(prefix) || redacted.includes(prefix));

  let cursor = 0;
  let masked = "";
  const selections = mentions.map((mention, index) => {
    const marker = `${prefix}${index}end`;
    const label = redact(text.slice(mention.start, mention.end));
    masked += text.slice(cursor, mention.start) + marker;
    cursor = mention.end;
    return { ...mention, marker, label, redactedStart: -1 };
  });
  masked += text.slice(cursor);
  let restored = redact(masked);
  for (const selection of selections) {
    selection.redactedStart = restored.indexOf(selection.marker);
    restored = restored.replace(selection.marker, () => selection.label);
  }
  // Markers must not change context-sensitive secret filtering. Never restore
  // protected text unless the result equals redaction of the complete source.
  if (restored !== redacted) {
    return { fallback, recipients: [] };
  }

  const seen = new Set<string>();
  const recipients: PreparedMentionExcerpt[] = [];
  for (const selection of selections) {
    if (
      seen.has(selection.profileId) ||
      selection.label !== text.slice(selection.start, selection.end)
    ) {
      continue;
    }
    if (selection.redactedStart < 0) {
      continue;
    }
    const redactedEnd = selection.redactedStart + selection.label.length;
    const sourceStart = Math.max(0, selection.redactedStart - SOURCE_CONTEXT);
    const sourceEnd = Math.min(redacted.length, redactedEnd + SOURCE_CONTEXT);
    // Large messages only send bounded recipient context through the lossy
    // Markdown preview formatter. Redaction above still sees the complete input.
    let plain = clean(
      flattenMarkdownToPlainText(
        sliceUtf16Safe(redacted, sourceStart, selection.redactedStart) +
          selection.marker +
          sliceUtf16Safe(redacted, redactedEnd, sourceEnd),
      ),
    );
    const mentionStart = plain.indexOf(selection.marker);
    const label = clean(selection.label);
    if (mentionStart < 0 || !label || label.length > MAX_EXCERPT - 4) {
      continue;
    }
    seen.add(selection.profileId);
    plain = plain.replace(selection.marker, () => label);
    const mentionEnd = mentionStart + label.length;
    // Keep the name near the front so compact multi-line surfaces do not clamp
    // it away. The remaining budget belongs to its immediate reply context.
    const beforeBudget = Math.min(BEFORE_MENTION, MAX_EXCERPT - label.length - 4);
    let start = Math.max(0, mentionStart - beforeBudget);
    if (start > 0) {
      const boundary = plain.indexOf(" ", start);
      if (boundary >= 0 && boundary < mentionStart) {
        start = boundary + 1;
      }
    }
    const before = sliceUtf16Safe(plain, start, mentionStart).trimStart();
    const leading = start > 0 || sourceStart > 0 ? "… " : "";
    const remaining = MAX_EXCERPT - leading.length - before.length - label.length;
    const tail = plain.slice(mentionEnd);
    const trailing = tail.length > remaining || sourceEnd < redacted.length ? " …" : "";
    let after = truncateUtf16Safe(tail, remaining - trailing.length);
    if (trailing) {
      const boundary = after.lastIndexOf(" ");
      if (boundary >= 0 && boundary > after.length - 24) {
        after = after.slice(0, boundary);
      }
    }
    const excerpt = `${leading}${before}${label}${after.trimEnd()}${trailing}`;
    const startInExcerpt = leading.length + before.length;
    recipients.push({
      profileId: selection.profileId,
      excerpt,
      excerptMention: { start: startInExcerpt, end: startInExcerpt + label.length },
    });
  }
  return { fallback, recipients };
}

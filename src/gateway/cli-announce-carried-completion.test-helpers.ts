import { INBOUND_CONTEXT_MARKER } from "../auto-reply/reply/inbound-context-marker.js";
import { escapeRegExp } from "../shared/regexp.js";

export type CarriedCompletionRecord = { source: string; prompt?: string; reply: string };

/** A fenced JSON block that follows an OpenClaw context label (`... ⟦openclaw:ctx⟧`). */
const MARKED_JSON_BLOCK = new RegExp(
  `${escapeRegExp(INBOUND_CONTEXT_MARKER)}\\s*\`\`\`json\\s*([\\s\\S]*?)\\s*\`\`\``,
  "g",
);

/**
 * Finds the announced completion among the marked completion records of one native user
 * turn. A completion saved without a user row carries only its source and reply, so the
 * prompt envelope is optional. Fences and replies are matched with whitespace collapsed, so
 * a reader that normalizes whitespace still matches.
 */
export function findCarriedCompletion(
  text: string,
  completionReply: string,
): CarriedCompletionRecord | undefined {
  const expected = collapseWhitespace(completionReply).slice(0, 48);
  for (const [, block = ""] of text.matchAll(MARKED_JSON_BLOCK)) {
    let records: unknown;
    try {
      records = JSON.parse(block);
    } catch {
      continue;
    }
    for (const record of Array.isArray(records) ? records : []) {
      const candidate = record as { source?: unknown; prompt?: unknown; reply?: unknown } | null;
      if (
        candidate?.source === "subagent_announce" &&
        typeof candidate.reply === "string" &&
        collapseWhitespace(candidate.reply).includes(expected)
      ) {
        return candidate as CarriedCompletionRecord;
      }
    }
  }
  return undefined;
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Per-run scoping for `chat.history`.
 *
 * Session JSONL has no top-level runId field per message, so agents stamp
 * `run_id=<id>` markers inside their emitted content (RUN_RESULT,
 * INSTRUCTION_BUNDLE tail, structured fields, etc.).  We match via a
 * serialized-text check on the raw message so any such marker — wherever
 * it lives in the record — registers as a hit.  Cyclic records (which
 * `JSON.stringify` throws on) are treated as non-matches.
 *
 * Applied *before* size-budget sanitization so that a long message whose
 * runId marker sits in the truncated tail still counts as part of the
 * run.  Sanitization/placeholder passes then run on the already-scoped
 * subset.
 *
 * The match is bounded on both sides by non-identifier characters
 * (Unicode letters/numbers/marks plus `_` and `-`), so `run-1` does not
 * match a message tagged with `run-10`, and a CJK runId like `会` does
 * not match one whose marker says `会議`.  The runId is re-encoded
 * through `JSON.stringify` before the search so runIds that contain
 * characters `JSON.stringify` escapes (quotes, backslashes, control
 * chars, etc.) still find their markers inside an already-serialized
 * record.
 */
const RUN_ID_BOUNDARY_CHAR_SOURCE = "[\\p{L}\\p{N}\\p{M}_-]";
const REGEX_META = /[.*+?^${}()|[\]\\]/g;

export function matchesRunId(message: unknown, runId: string): boolean {
  try {
    const serialized = JSON.stringify(message);
    if (!serialized) {
      return false;
    }
    // Encode runId the same way stringify would encode it as a JSON string
    // body, so escape sequences line up with the serialized record.
    const encoded = JSON.stringify(runId).slice(1, -1);
    const pattern = new RegExp(
      `(?<!${RUN_ID_BOUNDARY_CHAR_SOURCE})${encoded.replace(REGEX_META, "\\$&")}(?!${RUN_ID_BOUNDARY_CHAR_SOURCE})`,
      "u",
    );
    return pattern.test(serialized);
  } catch {
    return false;
  }
}

export function filterMessagesByRunId<T>(messages: T[], runId: string | undefined): T[] {
  if (!runId) {
    return messages;
  }
  return messages.filter((message) => matchesRunId(message, runId));
}

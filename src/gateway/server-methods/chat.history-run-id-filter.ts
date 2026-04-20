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
 */
export function matchesRunId(message: unknown, runId: string): boolean {
  try {
    return JSON.stringify(message).includes(runId);
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

// Numbers that name *when* an attempt happened rather than *why* it failed.
// Only these are erased from a failure's identity: a clock or ISO timestamp, an
// explicit attempt/retry counter, an elapsed duration, and a pid. Every other
// number keeps its meaning, so `errno 111` stays distinct from `errno 113` and
// HTTP 401 stays distinct from 403.
const VOLATILE_DIAGNOSTIC_PATTERNS: readonly RegExp[] = [
  /\d{4}-\d{2}-\d{2}[t ]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:z|[+-]\d{2}:\d{2})?/giu,
  /\d{4}-\d{2}-\d{2}/gu,
  /\d{1,2}:\d{2}:\d{2}(?:\.\d{1,6})?/gu,
  /\b(?:attempt|retry|try|iteration|pass)\b[\s#:=]*\d+/giu,
  /\b\d+(?:\.\d+)?\s?(?:ms|us|ns|sec|secs|seconds|s|m|h)\b/giu,
  /\b(?:pid|ppid|tid|thread)\b[\s#:=]*\d+/giu,
];

/**
 * Identity-preserving normalization of terminal `exec` diagnostics.
 *
 * Retries of one failure differ only in when they happened; that drift would
 * otherwise make every attempt look like a brand new failure. Erase just those
 * volatile spans and keep the rest of the message, including any number that
 * carries a cause, so a genuinely different failure stays different.
 */
function normalizeExecFailureShape(text: string): string {
  let shape = text;
  for (const pattern of VOLATILE_DIAGNOSTIC_PATTERNS) {
    shape = shape.replace(pattern, "#");
  }
  return shape;
}

/**
 * Facts that make two terminal exec failures the same failure: the structured
 * outcome plus the drift-free shape of the diagnostics. Hashed by the caller.
 */
export function execFailureIdentityInput(
  details: Record<string, unknown>,
  exitCode: unknown,
  output: string,
): Record<string, unknown> {
  return {
    status: details.status,
    exitCode,
    timedOut: details.timedOut === true,
    shape: normalizeExecFailureShape(output),
  };
}

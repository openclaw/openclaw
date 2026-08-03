/**
 * Identity of a terminal `exec` failure for loop detection.
 *
 * Retry diagnostics differ run to run only in their numbers: clock times,
 * attempt counters, pids, ports, byte counts. Collapsing digit runs keeps the
 * prose that names the failure cause while dropping that drift, so a repeat of
 * one failure stays recognizable and a genuinely different message does not.
 */
export function normalizeExecFailureShape(text: string): string {
  return text.replace(/\d+/gu, "#");
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

export const GATEWAY_RESTART_RESUME_TEXT =
  "The Gateway restarted while you were working. Check current state and resume. " +
  "Child runs do not resume independently. Check saved work before giving the same child new instructions. " +
  "A stop is not a yield; restart preserves workspace and publication ownership.";

/** Preserve structured provenance even when an operator-supplied ID is unsuitable for prompt text. */
export function buildGatewayRestartResumeText(
  sourceRunId?: string,
  unresolvedShell = false,
): string {
  const source =
    sourceRunId && /^[A-Za-z0-9_.:-]{1,128}$/.test(sourceRunId)
      ? ` for interrupted run ${sourceRunId}`
      : "";
  const shell = unresolvedShell
    ? " A shell command has no saved terminal result. Do not rerun it or replay the request. Use an authorized read-only check if needed; absence is inconclusive."
    : "";
  return `${GATEWAY_RESTART_RESUME_TEXT} Use saved tool results${source} (nested calls, IDs, errors).${shell} Report verified and unknown outcomes; never retry uncertain effects. Continue independent work.`;
}

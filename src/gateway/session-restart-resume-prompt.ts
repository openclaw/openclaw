export const GATEWAY_RESTART_RESUME_TEXT =
  "The Gateway restarted while you were working. Resume without replaying the request. " +
  "Child runs do not resume independently. Inspect saved work before continuing the same child. " +
  "A stop is not a yield; workspace and publication ownership do not transfer.";

/** Preserve structured provenance even when an operator-supplied ID is unsuitable for prompt text. */
export function buildGatewayRestartResumeText(
  sourceRunId?: string,
  unresolvedShell = false,
): string {
  const source =
    sourceRunId && /^[A-Za-z0-9_.:-]{1,128}$/.test(sourceRunId)
      ? ` for interrupted run ${sourceRunId}`
      : "";
  const shell = unresolvedShell ? " A shell command has no saved terminal result." : "";
  return `${GATEWAY_RESTART_RESUME_TEXT} Use saved results${source} (nested calls, IDs, errors).${shell} Report unknown effects without retrying them. Keep working on the request.`;
}

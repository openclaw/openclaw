export const GATEWAY_RESTART_RESUME_TEXT =
  "The Gateway restarted while you were working. Resume your work: check the current state of anything that was in progress (files, processes, subagents, external actions) before repeating it, then continue. Child runs do not resume independently. Inspect their saved work; send a fresh instruction to the same retained child session when appropriate. A stopped execution is not a yielded pause, and restarting it does not transfer workspace or publication ownership.";

/** Preserve structured provenance even when an operator-supplied ID is unsuitable for prompt text. */
export function buildGatewayRestartResumeText(
  sourceRunId?: string,
  unresolvedShell = false,
): string {
  const source =
    sourceRunId && /^[A-Za-z0-9_.:-]{1,128}$/.test(sourceRunId)
      ? ` for interrupted run ${sourceRunId}`
      : "";
  const nextStep = unresolvedShell
    ? "A shell command has no saved terminal result. Do not rerun it or replay the request. If saved evidence is insufficient, use a targeted, authorized read-only check. Absence alone does not rule out an effect. Continue independent work without asking the user to resume; report verified and unknown outcomes without retrying uncertain effects."
    : "If a side effect has no attributable result, report its outcome as unknown and do not retry it. Continue independent work.";
  return `${GATEWAY_RESTART_RESUME_TEXT} Inspect the recorded tool results${source}, including nested calls. Use returned identifiers and recorded errors when reporting the outcome. ${nextStep}`;
}

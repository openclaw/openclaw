export const GATEWAY_RESTART_RESUME_TEXT =
  "The Gateway restarted while you were working. Resume your work: check the current state of anything that was in progress (files, processes, subagents, external actions) before repeating it, then continue. Child runs do not resume independently. Inspect their saved work; send a fresh instruction to the same retained child session when appropriate. A stopped execution is not a yielded pause, and restarting it does not transfer workspace or publication ownership.";

/** Preserve structured provenance even when an operator-supplied ID is unsuitable for prompt text. */
export function buildGatewayRestartResumeText(sourceRunId?: string): string {
  const source =
    sourceRunId && /^[A-Za-z0-9_.:-]{1,128}$/.test(sourceRunId)
      ? ` for interrupted run ${sourceRunId}`
      : "";
  return `${GATEWAY_RESTART_RESUME_TEXT} Inspect the recorded tool results${source}, including nested calls. Use returned identifiers and recorded errors when reporting the outcome. If a side effect has no attributable result, report its outcome as unknown and do not retry it. Continue independent work.`;
}

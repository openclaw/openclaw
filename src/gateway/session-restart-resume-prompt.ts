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
  const shellCheckpoint = unresolvedShell
    ? " The interrupted turn has a shell command with no saved terminal result. Do not rerun that command or start the original request over. First use saved observations and authorized read-only checks for what it was meant to produce, such as the named job or expected file. Reuse verified work. A missing file or job is not proof that the command did nothing; if its effect cannot be verified, say it is unknown. Continue safe remaining steps and give a visible final answer explaining what you verified and what is still unknown."
    : "";
  return `${GATEWAY_RESTART_RESUME_TEXT} Inspect the recorded tool results${source}, including nested calls. Use returned identifiers and recorded errors when reporting the outcome. If a side effect has no attributable result, report its outcome as unknown and do not retry it. Continue independent work.${shellCheckpoint}`;
}

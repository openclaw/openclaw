import { setAbortMemory } from "./abort-primitives.js";

/**
 * Opens a prompt with the note that a user's Stop ended the previous run, for the one turn whose
 * claim retired that Stop (`claimUserStopForAdmittedTurn`); the transcript keeps the user's text.
 */
export function stateUserStop(body: string, stopClaimed: boolean | undefined): string {
  return stopClaimed
    ? "Note: The user stopped the previous agent run. Do not resume or retry that work " +
        "unless the latest user message asks for it; if what they want is unclear, ask.\n\n" +
        body
    : body;
}

/** Prompt preparation must leave durable interruption state with the recovery owner. */
export function applySessionHints(params: {
  baseBody: string;
  abortedLastRun: boolean;
  abortKey?: string;
}): string {
  if (!params.abortedLastRun) {
    return params.baseBody;
  }
  if (params.abortKey) {
    setAbortMemory(params.abortKey, false);
  }
  return (
    "Note: The previous agent run was interrupted. Review the transcript and current state, " +
    "then continue the unfinished work in light of the latest user message.\n\n" +
    params.baseBody
  );
}

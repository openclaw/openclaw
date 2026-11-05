import { setAbortMemory } from "./abort-primitives.js";

/** Prompt preparation must leave durable interruption state with the recovery owner. */
export function applySessionHints(params: {
  baseBody: string;
  abortedLastRun: boolean;
  /** A user's Stop ended the last run; it must not read as an interruption to resume. */
  stoppedByUser?: boolean;
  abortKey?: string;
}): string {
  if (!params.abortedLastRun && !params.stoppedByUser) {
    return params.baseBody;
  }
  if (params.abortKey) {
    setAbortMemory(params.abortKey, false);
  }
  if (params.stoppedByUser) {
    return (
      "Note: The user stopped the previous agent run. Do not resume or retry that work " +
      "unless the latest user message asks for it; if what they want is unclear, ask.\n\n" +
      params.baseBody
    );
  }
  return (
    "Note: The previous agent run was interrupted. Review the transcript and current state, " +
    "then continue the unfinished work in light of the latest user message.\n\n" +
    params.baseBody
  );
}

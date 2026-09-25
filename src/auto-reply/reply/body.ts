import { setAbortMemory } from "./abort-primitives.js";

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

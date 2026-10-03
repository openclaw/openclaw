import type { InternalSessionEntry } from "./types.js";

/** Provenance of this exact source incarnation, independent of the current binding. */
export function hasCurrentAcpSourceTurn(entry: InternalSessionEntry): boolean {
  const turn = entry.acpSourceTurn;
  return Boolean(
    turn &&
    turn.sourceSessionId === entry.sessionId &&
    turn.sourceLifecycleRevision === entry.lifecycleRevision &&
    (entry.activeWriterRunId === undefined || entry.activeWriterRunId === turn.runId) &&
    (entry.lifecycleRunId === undefined || entry.lifecycleRunId === turn.runId),
  );
}

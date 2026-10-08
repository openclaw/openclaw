import type { AgentWorkerOperationContext } from "../../state/openclaw-agent-operation-context.js";
import { prepareSessionEntryReplacementPublication } from "./session-accessor.sqlite-replacement-state.js";
import { transferSessionEntryWorkerCandidate } from "./session-entry-patch.worker.js";
import { applySessionResetInDatabase } from "./session-reset.kernel.js";
import type { SessionResetCommit, SessionResetCommitted } from "./session-reset.types.js";

export function commitSessionReset(
  input: SessionResetCommit,
  { writeTransaction, admit }: AgentWorkerOperationContext,
) {
  return writeTransaction("session.lifecycle.reset", "Session reset", (database) => {
    let projectionNeedsReconcile = false;
    const { current, written, progressCardReset } = applySessionResetInDatabase(database, input, {
      scheduleProjectionReconcile: false,
      onProjectionReconcileNeeded: () => {
        projectionNeedsReconcile = true;
      },
    });
    const candidate: SessionResetCommitted = {
      kind: "session-reset",
      mutation: {
        nextEntry: input.nextEntry,
        ...(current ? { previousEntry: current.entry } : {}),
        ...(current?.entry.sessionId ? { previousSessionId: current.entry.sessionId } : {}),
      },
      previousSessionKeys: input.prepared.map((row) => row.sessionKey),
      progressCardReset,
      projectionNeedsReconcile,
      publication: prepareSessionEntryReplacementPublication(
        {
          previous: new Map(input.prepared.map((row) => [row.sessionKey, row.entry])),
          current: new Map([[input.target.canonicalKey, written]]),
          pendingArchiveRecovery: false,
          membershipInvalidatedKeys:
            current?.entry.sessionId !== written.sessionId ? [input.target.canonicalKey] : [],
          maintenancePlans: [],
        },
        database,
      ),
    };
    return transferSessionEntryWorkerCandidate(database, admit, candidate);
  });
}

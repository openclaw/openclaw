import { sessionChanges } from "../../sessions/session-row-changes.js";
import type { OpenClawAgentDatabaseOptions } from "../../state/openclaw-agent-db-contract.js";
import { captureOpenClawAgentDatabaseExecutionAsync } from "../../state/openclaw-agent-execution.js";
import { runOpenClawAgentWorkerWrite } from "../../state/openclaw-agent-write-admission.js";
import { invalidateSessionEntryCaches } from "./session-accessor.sqlite-entry-cache-publication.js";
import { createSessionWorkerExecutionSource } from "./session-worker-execution-source.js";

/** Read committed entry and membership through the current native executor, then settle. */
export async function readCommittedSessionSharingAuthority(
  database: OpenClawAgentDatabaseOptions & { path: string },
  databaseIdentity: string,
  sessionKeys: readonly string[],
  settle: () => void,
): Promise<void> {
  await runOpenClawAgentWorkerWrite(database, async () => {
    const execution = await captureOpenClawAgentDatabaseExecutionAsync(database);
    try {
      const source = createSessionWorkerExecutionSource(
        () => execution.assertCurrent(),
        "Session sharing reconciliation lost its database owner",
      );
      const result = await execution.runExisting(source, (worker) =>
        worker.execute({
          type: "session.entry.read",
          input: { sessionKeys: [...sessionKeys], snapshotFields: [], includeMembers: true },
        }),
      );
      execution.assertCurrent();
      if (!result || result.databaseIdentity.identity !== databaseIdentity || !result.members) {
        throw new Error("Session sharing reconciliation did not establish committed facts");
      }
      // The cohort reads entry and membership (including absence) in one native statement.
      // Retire projections before allowing new acquisitions; old grants stay permanently lost.
      invalidateSessionEntryCaches(databaseIdentity);
      sessionChanges.emitBatch(
        sessionKeys.map((sessionKey) => ({
          agentId: database.agentId,
          storePath: database.path,
          sessionKey,
          factsInvalidated: true,
        })),
      );
    } finally {
      await execution.release();
    }
    settle();
  });
}

import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import { readSessionCleanupSnapshotInDatabase } from "./cleanup-service-read.kernel.js";
import type {
  SessionCleanupReadInput,
  SessionCleanupReadResult,
} from "./cleanup-service-read.types.js";
import { captureSessionEntryReadSource } from "./session-entry-read-source.js";

export function readSessionCleanupSnapshot(
  request: SessionCleanupReadInput,
): SessionCleanupReadResult {
  const result = withOpenClawAgentDatabaseReadOnly(
    (database) => {
      const source = captureSessionEntryReadSource(database, request.expectedIdentity);
      return { ...readSessionCleanupSnapshotInDatabase(database, request), source };
    },
    { ...request.database, env: request.env },
  );
  if (!result.found && request.expectedIdentity?.key.startsWith("file:")) {
    throw new Error("Session cleanup lost its captured physical owner");
  }
  return result.found ? result.value : { kind: "session-cleanup", store: {}, missing: [] };
}

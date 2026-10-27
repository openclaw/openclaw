import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import type { OpenClawAgentDatabaseOptions } from "../../state/openclaw-agent-db.js";
import { readSessionColdStorageInventory } from "./session-cold-storage-inventory.js";
import { readSessionColdTranscript } from "./session-cold-storage-state.js";

export function readSessionColdStorageInventoryInWorker(options: OpenClawAgentDatabaseOptions) {
  const counts = withOpenClawAgentDatabaseReadOnly(readSessionColdStorageInventory, options);
  return counts.found ? counts.value : readSessionColdStorageInventory();
}

export function readSessionColdMetadataInWorker(
  options: OpenClawAgentDatabaseOptions,
  sessionId: string,
) {
  const result = withOpenClawAgentDatabaseReadOnly(
    (database) => readSessionColdTranscript(database.db, sessionId),
    options,
  );
  return result.found ? result.value : undefined;
}

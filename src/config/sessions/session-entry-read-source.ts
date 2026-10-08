import {
  assertOpenClawAgentDatabaseIdentity,
  isOpenClawAgentDatabasePathCurrent,
  readOpenClawAgentDatabaseIdentity,
} from "../../state/openclaw-agent-db-identity.js";
import type { listSqliteSessionEntriesFromDatabase } from "./session-accessor.sqlite-entry-list.read.js";
import type { SessionEntryListWorkerInput } from "./session-entry-read.types.js";

export function captureSessionEntryReadSource(
  database: Parameters<typeof listSqliteSessionEntriesFromDatabase>[0],
  expectedIdentity: SessionEntryListWorkerInput["expectedIdentity"],
  unavailableMessage = "Session entry read requires its current durable owner",
) {
  if (expectedIdentity) {
    assertOpenClawAgentDatabaseIdentity(database, expectedIdentity);
  }
  const identity = readOpenClawAgentDatabaseIdentity(database);
  if (typeof identity.identity !== "string" || !isOpenClawAgentDatabasePathCurrent(database)) {
    throw new Error(unavailableMessage);
  }
  return {
    agentId: database.agentId,
    path: database.path,
    databaseIdentity: identity.identity,
    databaseBirthtime: identity.birthtime,
  };
}

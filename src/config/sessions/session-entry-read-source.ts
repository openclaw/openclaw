import {
  assertExistingDatabaseIdentity,
  type DatabasePathIdentity,
} from "../../infra/sqlite-worker-identity.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db-contract.js";
import {
  assertOpenClawAgentDatabaseIdentity,
  isOpenClawAgentDatabasePathCurrent,
  readOpenClawAgentDatabaseIdentity,
} from "../../state/openclaw-agent-db-identity.js";
import type { CapturedSessionEntryReadSource } from "./session-entry-read-source.types.js";

export function captureSessionEntryReadSource(
  database: Pick<OpenClawAgentDatabase, "agentId" | "db" | "path">,
  expectedIdentity: DatabasePathIdentity | undefined,
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

export function assertCapturedSessionEntryReadSource(
  source: CapturedSessionEntryReadSource,
  database?: Pick<OpenClawAgentDatabase, "agentId" | "path" | "db">,
): void {
  if (typeof source.databaseIdentity === "string" && (!database || database.path !== source.path)) {
    assertExistingDatabaseIdentity(
      source.path,
      `file:${source.databaseIdentity}`,
      source.databaseBirthtime,
    );
  }
  if (!database) {
    if (typeof source.databaseIdentity === "symbol") {
      throw new Error("Captured session database is no longer open");
    }
    return;
  }
  const physical = readOpenClawAgentDatabaseIdentity(database);
  if (
    database.agentId !== source.agentId ||
    physical.identity !== source.databaseIdentity ||
    physical.birthtime !== source.databaseBirthtime ||
    !isOpenClawAgentDatabasePathCurrent(database)
  ) {
    throw new Error("Captured session database changed before read");
  }
}

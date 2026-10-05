import { runSqliteDeferredTransactionSync } from "../../infra/sqlite-transaction.js";
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { readSessionEntryRow } from "./session-accessor.sqlite-entry-read.js";
import type { SessionPendingInputAuthorityFacts } from "./session-pending-input-authority.js";
import { listSessionMembersInDatabase } from "./session-sharing-store.kernel.js";

export function readSessionPendingInputAuthorityFacts(
  database: Pick<OpenClawAgentDatabase, "db" | "path" | "agentId">,
  sessionKey: string,
  agentId = database.agentId,
): SessionPendingInputAuthorityFacts {
  return runSqliteDeferredTransactionSync(database.db, () => {
    const identity = readOpenClawAgentDatabaseIdentity(database);
    return {
      agentId,
      storePath: database.path,
      sessionKey,
      entry: readSessionEntryRow(database, sessionKey, "list")?.entry,
      readSource:
        typeof identity.identity === "string"
          ? {
              agentId: database.agentId,
              path: database.path,
              databaseIdentity: identity.identity,
              databaseBirthtime: identity.birthtime,
            }
          : undefined,
      members: listSessionMembersInDatabase(database, sessionKey),
    };
  });
}

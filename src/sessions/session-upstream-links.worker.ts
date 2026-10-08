import { requestSessionEntryCurrentAdmission } from "../config/sessions/session-entry-current-admission.worker.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import type { SqliteWorkerCommand } from "../infra/sqlite-worker-contract.js";
import { requestSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import { isSessionStateUpstreamCurrentInDatabase } from "./session-state-events.kernel.js";
import {
  deleteSessionUpstreamLinkInDatabase,
  rowToSessionUpstreamLink,
  sessionUpstreamLinkSourceMatches,
  upsertSessionUpstreamLinkInDatabase,
} from "./session-upstream-links.kernel.js";
import type { SessionUpstreamWorkerOperations } from "./session-upstream-links.worker-contract.js";

export function executeSessionUpstreamCommand(
  command: SqliteWorkerCommand<SessionUpstreamWorkerOperations>,
  options: OpenClawStateDatabaseOptions & { database: OpenClawStateDatabase },
): boolean | "deleted" | "absent" | "changed" {
  if (command.type === "sessionUpstream.current") {
    return isSessionStateUpstreamCurrentInDatabase(options.database.db, command.input);
  }
  if (command.type === "sessionUpstream.upsert" || command.type === "sessionUpstream.delete") {
    return runOpenClawStateWriteTransaction(({ db }) => {
      const assertSource = () => {
        const source = command.type === "sessionUpstream.upsert" ? command.input.source : undefined;
        if (!source) {
          return;
        }
        const row = executeSqliteQuerySync(
          db,
          getNodeSqliteKysely<Pick<DB, "session_upstream_links">>(db)
            .selectFrom("session_upstream_links")
            .selectAll()
            .where("session_key", "=", source.sessionKey)
            .where("agent_id", "=", source.agentId),
        ).rows[0];
        if (
          !sessionUpstreamLinkSourceMatches(row ? rowToSessionUpstreamLink(row) : undefined, source)
        ) {
          throw new Error("Session upstream source changed during initialization");
        }
      };
      const admit = (stage: "transaction" | "commit") => {
        assertSource();
        requestSqliteWorkerOperationAdmission({ stage, facts: undefined });
        assertSource();
      };
      admit("transaction");
      const result =
        command.type === "sessionUpstream.upsert"
          ? upsertSessionUpstreamLinkInDatabase(
              db,
              command.input.link,
              command.input.now,
              command.input.ifAbsent,
            )
          : deleteSessionUpstreamLinkInDatabase(
              db,
              command.input.sessionKey,
              command.input.agentId,
              command.input.expected,
            );
      admit("commit");
      return result;
    }, options);
  }
  const { expected, settlement, sessionEntryCurrentSource } = command.input;
  const admit = (stage: "transaction" | "commit") =>
    requestSessionEntryCurrentAdmission(sessionEntryCurrentSource, { stage, facts: undefined });
  return runOpenClawStateWriteTransaction(({ db }) => {
    admit("transaction");
    if (!isSessionStateUpstreamCurrentInDatabase(db, expected)) {
      return false;
    }
    const query = getNodeSqliteKysely<Pick<DB, "session_upstream_links">>(db);
    if (settlement.kind === "missing") {
      executeSqliteQuerySync(
        db,
        query
          .deleteFrom("session_upstream_links")
          .where("session_key", "=", expected.sessionKey)
          .where("agent_id", "=", expected.agentId),
      );
    } else {
      executeSqliteQuerySync(
        db,
        query
          .updateTable("session_upstream_links")
          .set({
            last_marker_json: JSON.stringify(settlement.marker),
            last_scanned_at: settlement.now,
            updated_at: settlement.now,
          })
          .where("session_key", "=", expected.sessionKey)
          .where("agent_id", "=", expected.agentId),
      );
    }
    admit("commit");
    return true;
  }, options);
}

import path from "node:path";
import type { DB as OpenClawAgentKyselyDatabase } from "../state/openclaw-agent-db.generated.js";
import { INCOGNITO_AGENT_SQLITE_BASENAME } from "../state/openclaw-agent-db.paths.js";
import {
  claimHeartbeatOutcomeRowInDatabase,
  persistHeartbeatOutcomeInDatabase,
  type HeartbeatOutcomeInput,
  type HeartbeatOutcomeRow,
} from "./heartbeat-outcome-store.kernel.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "./kysely-sync.js";
import { runSqliteSingleStatementSync } from "./sqlite-transaction.js";
import { bindSqliteWorkerDatabase } from "./sqlite-worker-binding.js";
import type { SqliteWorkerBackend } from "./sqlite-worker-contract.js";
import type { SqliteWorkerDatabaseContext } from "./sqlite-worker-database-context.js";

export type HeartbeatOutcomeWorkerOperations = {
  persist: { input: HeartbeatOutcomeInput; output: HeartbeatOutcomeRow | undefined };
  claim: { input: { sessionKey: string; runId: string }; output: HeartbeatOutcomeRow | undefined };
};

/** Borrows the canonical agent connection for one admitted outcome operation. */
export function bindSqliteWorkerBackend(
  _input: undefined,
  context: SqliteWorkerDatabaseContext,
): SqliteWorkerBackend<HeartbeatOutcomeWorkerOperations> {
  const db = context.database;
  // The in-memory lifecycle owner requires a commit receipt for every mutation command.
  const requiresMutationReceipt =
    path.basename(context.databasePath) === INCOGNITO_AGENT_SQLITE_BASENAME;
  return bindSqliteWorkerDatabase<HeartbeatOutcomeWorkerOperations>(db, {
    execute(command) {
      context.admit("transaction");
      if (command.type === "claim" && !requiresMutationReceipt) {
        const row = executeSqliteQuerySync(
          db,
          getNodeSqliteKysely<Pick<OpenClawAgentKyselyDatabase, "heartbeat_outcomes">>(db)
            .selectFrom("heartbeat_outcomes")
            .selectAll()
            .where("session_key", "=", command.input.sessionKey),
        ).rows[0];
        // The FIFO is still held; absent outcomes and durable retries need no new write.
        if (!row || (row.context_run_id !== null && row.context_claimed_at !== null)) {
          return row;
        }
      }
      context.admit("commit");
      return runSqliteSingleStatementSync(db, () =>
        command.type === "persist"
          ? persistHeartbeatOutcomeInDatabase(db, command.input)
          : claimHeartbeatOutcomeRowInDatabase(db, command.input),
      );
    },
  });
}

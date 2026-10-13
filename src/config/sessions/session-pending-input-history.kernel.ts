import { sql } from "kysely";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
} from "../../infra/kysely-sync.js";
import { parseSqliteTableDefinition } from "../../infra/sqlite-schema-contract-assembly.js";
import { getAdmittedSqliteSchemaFacts } from "../../infra/sqlite-schema-facts.js";
import { runSqliteDeferredTransactionSync } from "../../infra/sqlite-transaction.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope.js";
import type {
  PendingInputHistoryQuery,
  PendingInputHistorySnapshot,
} from "./session-pending-input-history.types.js";
import {
  resolvePendingInputHistoryLimit,
  selectPendingInputHistoryPage,
} from "./session-pending-input-value.js";

/** The admitted reader owns the snapshot; process-held incognito uses the same kernel. */
export function readPendingInputHistoryInDatabase(
  database: Pick<OpenClawAgentDatabase, "db">,
  query: PendingInputHistoryQuery,
): PendingInputHistorySnapshot {
  return runSqliteDeferredTransactionSync(database.db, () => {
    const schema = getAdmittedSqliteSchemaFacts(database.db);
    if (!schema) {
      throw new Error("Pending input history requires admitted schema facts");
    }
    const table = schema.tableSql.get("session_pending_inputs");
    if (!table) {
      return { rows: [], total: 0 };
    }
    const hasConsumption = parseSqliteTableDefinition(table, "session_pending_inputs").columns.has(
      "consumed_event_id",
    );
    const db = getSessionKysely(database.db);
    let base = db
      .selectFrom("session_pending_inputs")
      .where("session_key", "=", query.sessionKey)
      .where("session_id", "=", query.sessionId);
    if (hasConsumption) {
      base = base.where("consumed_event_id", "is", null);
    }
    const total =
      query.id === undefined
        ? (executeSqliteQueryTakeFirstSync(
            database.db,
            base.select(db.fn.count<number>("input_id").as("total")),
          )?.total ?? 0)
        : undefined;
    if (total === 0) {
      return { rows: [], total };
    }
    const limit = resolvePendingInputHistoryLimit(query.limit);
    let page = base.orderBy("seq", "desc").limit(limit + 1);
    if (query.before !== undefined) {
      page = page.where("seq", "<", query.before);
    }
    if (query.id !== undefined) {
      page = page.where("input_id", "=", query.id);
    }
    const metadata = executeSqliteQuerySync(
      database.db,
      page.select([
        "seq",
        db
          .selectFrom("session_nodes")
          .select("current_session_id")
          .where("session_key", "=", query.sessionKey)
          .as("current_session_id"),
        /* kysely-allow-raw: Bound the page before fetching accepted message JSON. */
        sql<number>`OCTET_LENGTH(message_json)`.as("serialized_bytes"),
      ]),
    ).rows;
    const { selected, nextBefore } = selectPendingInputHistoryPage(metadata, limit);
    const rows = selected.length
      ? executeSqliteQuerySync(
          database.db,
          base.selectAll().where("seq", "in", selected),
        ).rows.toSorted((a, b) => b.seq - a.seq)
      : [];
    return {
      rows,
      total,
      currentSessionId: metadata[0]?.current_session_id ?? undefined,
      nextBefore,
    };
  });
}

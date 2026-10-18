import { MAX_PAYLOAD_BYTES } from "../../gateway/payload-limits.js";
import { jsonPathValue } from "../../infra/database-engine/json-values.js";
import { getPostgresPhysicalFacts } from "../../infra/database-engine/physical-facts.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
} from "../../infra/kysely-sync.js";
import { getAdmittedSqliteSchemaFacts } from "../../infra/sqlite-schema-facts.js";
import { runSqliteReadSnapshotSync } from "../../infra/sqlite-transaction.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import {
  hasPendingInputConsumptionColumn,
  hasSessionPendingInputsSchema,
} from "../../state/openclaw-agent-pending-inputs-schema.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope.js";
import type {
  PendingInputHistoryQuery,
  PendingInputHistorySnapshot,
} from "./session-pending-input-history.types.js";
import { resolvePendingInputHistoryLimit } from "./session-pending-input-value.js";

/** The admitted reader owns the snapshot; process-held incognito uses the same kernel. */
export function readPendingInputHistoryInDatabase(
  database: Pick<OpenClawAgentDatabase, "db">,
  query: PendingInputHistoryQuery,
): PendingInputHistorySnapshot {
  const schema = getPostgresPhysicalFacts(database.db) ?? getAdmittedSqliteSchemaFacts(database.db);
  if (!schema) {
    throw new Error("Pending input history requires admitted schema facts");
  }
  if (!hasSessionPendingInputsSchema(database.db)) {
    return { rows: [], total: 0 };
  }
  const hasConsumption = hasPendingInputConsumptionColumn(database.db);
  if (query.includeTotal === false) {
    return readPendingInputPageInDatabase(database, query, hasConsumption);
  }
  return runSqliteReadSnapshotSync(database.db, () => {
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
    return { ...readPendingInputPageInDatabase(database, query, hasConsumption), total };
  });
}

function readPendingInputPageInDatabase(
  database: Pick<OpenClawAgentDatabase, "db">,
  query: PendingInputHistoryQuery,
  hasConsumption: boolean,
): PendingInputHistorySnapshot {
  const limit = resolvePendingInputHistoryLimit(query.limit);
  const db = getSessionKysely(database.db);
  const page = executeSqliteQuerySync(
    database.db,
    db
      .with("pending_page", (qb) =>
        qb
          .selectFrom("session_pending_inputs")
          .select("seq")
          // Measure stored bytes before selecting any accepted-message payload.
          .select((eb) => eb.fn<number>("octet_length", ["message_json"]).as("serialized_bytes"))
          .where("session_key", "=", query.sessionKey)
          .where("session_id", "=", query.sessionId)
          .$if(hasConsumption, (selection) => selection.where("consumed_event_id", "is", null))
          .$if(query.sessionSendRecovery === true, (selection) =>
            selection
              .where("state", "in", ["queued", "interrupted"])
              .where((eb) =>
                eb(
                  jsonPathValue(
                    database.db,
                    eb.ref("message_json"),
                    eb.val("$.__openclaw.sessionSendDelivery"),
                  ),
                  "is not",
                  null,
                ),
              ),
          )
          .$if(query.before !== undefined, (selection) =>
            selection.where("seq", "<", query.before!),
          )
          .$if(query.id !== undefined, (selection) => selection.where("input_id", "=", query.id!))
          .orderBy("seq", "desc")
          .limit(limit + 1),
      )
      .with("bounded_page", (qb) =>
        qb
          .selectFrom("pending_page")
          .selectAll()
          .select((eb) => [
            eb.fn
              .sum<number>("serialized_bytes")
              .over((w) => w.orderBy("seq", "desc"))
              .as("page_bytes"),
            eb.fn
              .agg<number>("row_number", [])
              .over((w) => w.orderBy("seq", "desc"))
              .as("page_position"),
          ]),
      )
      .selectFrom("bounded_page")
      .innerJoin("session_pending_inputs as input", "input.seq", "bounded_page.seq")
      .select([
        "input.seq",
        "input.input_id",
        "input.session_key",
        "input.session_id",
        "input.idempotency_key",
        "input.run_id",
        "input.request_hash",
        "input.lifecycle_generation",
        "input.state",
        "input.accepted_at",
      ])
      .select((eb) => [
        (hasConsumption ? eb.ref("input.consumed_event_id") : eb.val(null)).as("consumed_event_id"),
        eb
          .case()
          .when(
            eb.and([
              eb("bounded_page.page_bytes", "<=", MAX_PAYLOAD_BYTES),
              eb("bounded_page.page_position", "<=", limit),
            ]),
          )
          .then(eb.ref("input.message_json"))
          .else(null)
          .end()
          .as("message_json"),
        eb
          .selectFrom("session_nodes")
          .select("current_session_id")
          .where("session_key", "=", query.sessionKey)
          .as("current_session_id"),
      ])
      .orderBy("bounded_page.seq", "desc"),
  ).rows;
  const omittedIndex = page.findIndex((row) => row.message_json === null);
  if (omittedIndex === 0) {
    throw new Error("Stored pending input exceeds the Gateway payload limit");
  }
  return {
    rows: page.flatMap(({ current_session_id: _current, ...row }) =>
      row.message_json === null ? [] : [{ ...row, message_json: row.message_json }],
    ),
    total: undefined,
    currentSessionId: page[0]?.current_session_id ?? undefined,
    nextBefore: omittedIndex > 0 ? page[omittedIndex - 1]?.seq : undefined,
  };
}

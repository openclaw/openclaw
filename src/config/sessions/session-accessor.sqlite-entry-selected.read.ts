import { expressionBuilder } from "kysely";
import {
  getNodeSqliteKysely,
  iterateSqliteQuerySync,
  sqliteStringSet,
} from "../../infra/kysely-sync.js";
import type { OpenClawAgentReadOnlyDatabase } from "../../state/openclaw-agent-db-readonly.js";
import type { DB } from "../../state/openclaw-agent-db.generated.js";
import { isInternalSessionEffectsKey } from "./internal-session-key.js";
import type { SessionEntrySummary } from "./session-accessor.sqlite-contract.js";
import {
  SESSION_ID_TRIM_CHARACTERS,
  validateDeliveryCanonicalSessionEntry,
} from "./session-accessor.sqlite-entry-read.js";
import { parseSessionEntryJson, selectSessionEntryRows } from "./session-accessor.sqlite-status.js";
import {
  assertCanonicalSqliteSessionKeysCurrent,
  hasCanonicalSessionValidationProjection,
  readWithCanonicalSessionReaderContinuation,
  type CanonicalSessionReaderContinuation,
} from "./session-canonical-key.js";

/** Select listing facts without hydrating the store; creation retains only its target payloads. */
export function readSelectedSessionEntriesInDatabase(
  database: OpenClawAgentReadOnlyDatabase,
  sessionKeys: readonly string[],
  options: {
    continuation?: CanonicalSessionReaderContinuation;
    fullEntryKeys?: readonly string[];
    label?: string;
    sessionIdOrKey?: string;
    transcriptSessionIds?: readonly string[];
  } = {},
): SessionEntrySummary[] {
  return readWithCanonicalSessionReaderContinuation(database, options.continuation, () => {
    assertCanonicalSqliteSessionKeysCurrent(database);
    const keys = new Set(sessionKeys);
    const fullEntryKeys = new Set(options.fullEntryKeys);
    const query = selectSessionEntryRows(database, "list", options.fullEntryKeys)
      .select("updated_at")
      .orderBy("session_key");
    const db = getNodeSqliteKysely<DB>(database.db);
    const pending = db.selectFrom("session_canonical_validation_pending").select("session_key");
    let selected = db
      .selectFrom("session_nodes")
      .select("session_key")
      .where("session_key", "in", sqliteStringSet(sessionKeys));
    if (options.label !== undefined) {
      selected = selected.union(
        db
          .selectFrom("session_nodes")
          .select("session_key")
          .where("label", "=", options.label.trim()),
      );
    }
    if (options.sessionIdOrKey !== undefined) {
      selected = selected
        .union(
          db
            .selectFrom("session_nodes")
            .select("session_key")
            .where("session_key", "=", options.sessionIdOrKey),
        )
        .union(
          db
            .selectFrom("session_nodes")
            .select("session_key")
            .where("current_session_id", "=", options.sessionIdOrKey),
        );
    }
    if (options.transcriptSessionIds !== undefined) {
      const ids = options.transcriptSessionIds;
      const trimmedIds = ids.map((id) => id.trim()).filter(Boolean);
      const eb = expressionBuilder<DB, "session_nodes">();
      const trimmed = eb.fn<string>("trim", [
        "current_session_id",
        eb.val(SESSION_ID_TRIM_CHARACTERS),
      ]);
      const seedIds = db
        .selectFrom("session_nodes")
        .select(trimmed.as("session_id"))
        .where("session_key", "in", sqliteStringSet(sessionKeys))
        .where(trimmed, "!=", "");
      selected = selected.union(
        db
          .selectFrom("session_nodes")
          .select("session_key")
          .where(
            eb.or([
              eb("current_session_id", "in", sqliteStringSet(ids)),
              eb(trimmed, "in", sqliteStringSet(trimmedIds)),
              eb(trimmed, "in", seedIds),
            ]),
          ),
      );
    }
    // Warm admission permits raw metadata changes. The listing contract still
    // rejects delivery-canonical sibling drift, so include its existing dirty set.
    // Older readers have no dirty set and retain their full validation inventory.
    const selectedQuery = query.select((eb) =>
      options.transcriptSessionIds === undefined
        ? eb.val(0).as("transcript_selected")
        : eb("session_key", "in", selected).as("transcript_selected"),
    );
    const rows = iterateSqliteQuerySync(
      database.db,
      hasCanonicalSessionValidationProjection(database)
        ? selectedQuery.where("session_key", "in", pending.union(selected))
        : selectedQuery,
    );
    const entries: SessionEntrySummary[] = [];
    for (const row of rows) {
      if (isInternalSessionEffectsKey(row.session_key)) {
        continue;
      }
      const entry = parseSessionEntryJson(
        row,
        fullEntryKeys.has(row.session_key) ? "full" : "list",
      );
      if (!entry) {
        continue;
      }
      validateDeliveryCanonicalSessionEntry(row.session_key, entry);
      if (
        keys.has(row.session_key) ||
        row.transcript_selected ||
        (options.label !== undefined && entry.label === options.label) ||
        (options.sessionIdOrKey !== undefined &&
          (row.session_key === options.sessionIdOrKey ||
            entry.sessionId === options.sessionIdOrKey))
      ) {
        entries.push({ sessionKey: row.session_key, entry });
      }
    }
    return entries;
  });
}

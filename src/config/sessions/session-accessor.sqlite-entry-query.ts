import type { DatabaseSync } from "node:sqlite";
import { sql } from "kysely";
import {
  createSqliteQueryCache,
  getNodeSqliteKysely,
  prepareSqliteQueryTakeFirstSync,
} from "../../infra/kysely-sync.js";
import {
  getSqliteReadScopeRevision,
  type SqliteReadScopeRevision,
} from "../../infra/sqlite-schema-facts.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db-contract.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import { hasSqliteSessionOwnerColumns } from "./session-accessor.sqlite-owner-projection.js";
import { selectSessionEntryRows } from "./session-accessor.sqlite-status.js";
import { canonicalSessionValidationQuery } from "./session-canonical-key.js";
import type { CanonicalSessionValidationRow } from "./session-canonical-row.js";
import type { SessionEntryProjection } from "./session-entry-snapshot-values.js";
import { sessionEntrySnapshotColumnsForKeys } from "./session-entry-snapshots.js";
import type { ResolvedSessionEntryRow } from "./session-entry-storage.types.js";

function cacheSessionEntryQuery<Row extends ResolvedSessionEntryRow["row"]>(
  database: DatabaseSync,
  query: (key: string) => Row | undefined,
): (key: string) => Row | undefined {
  let last: { key: string; revision: SqliteReadScopeRevision; row: Row | undefined } | undefined;
  return (key) => {
    const revision = getSqliteReadScopeRevision(database);
    if (revision && last?.revision === revision && last.key === key) {
      return last.row && { ...last.row };
    }
    const row = query(key);
    last =
      revision && getSqliteReadScopeRevision(database) === revision
        ? { key, revision, row }
        : undefined;
    // Mutation snapshots and parsers own their row, never the retained SQL result.
    return row && { ...row };
  };
}

// Each query retains only its last exact row at the connection's admitted revision.
export const getExactSessionEntryQueries = createSqliteQueryCache((database) => {
  const rowQueries = new Map<string, (key: string) => ResolvedSessionEntryRow["row"] | undefined>();
  const canonicalQueries = new Map<
    string,
    (key: string) => (CanonicalSessionValidationRow & ResolvedSessionEntryRow["row"]) | undefined
  >();
  return {
    row: (key: string, projection: SessionEntryProjection = "full") => {
      const shape = `${JSON.stringify(projection)}:${hasSqliteSessionOwnerColumns(database)}`;
      let query = rowQueries.get(shape);
      if (!query) {
        query = cacheSessionEntryQuery(
          database,
          prepareSqliteQueryTakeFirstSync<string, ResolvedSessionEntryRow["row"]>(
            database,
            (parameter) =>
              selectReadableSessionEntryRows({ db: database }, projection).where(
                "session_key",
                "=",
                parameter((value) => value),
              ),
          ),
        );
        rowQueries.set(shape, query);
      }
      return query(key);
    },
    canonical: (key: string, projection: SessionEntryProjection, includeOwner = true) => {
      const shape = `${JSON.stringify(projection)}:${includeOwner}:${includeOwner && hasSqliteSessionOwnerColumns(database)}`;
      let query = canonicalQueries.get(shape);
      if (!query) {
        query = cacheSessionEntryQuery(
          database,
          prepareSqliteQueryTakeFirstSync<
            string,
            CanonicalSessionValidationRow & ResolvedSessionEntryRow["row"]
          >(database, (parameter) =>
            canonicalSessionValidationQuery({ db: database }, { metadata: includeOwner })
              .$if(!includeOwner, (builder) => builder.select("session_nodes.updated_at"))
              .select(sessionEntrySnapshotColumnsForKeys(undefined, projection))
              .where(
                "session_nodes.session_key",
                "=",
                parameter((value) => value),
              ),
          ),
        );
        canonicalQueries.set(shape, query);
      }
      return query(key);
    },
  };
});

export function selectReadableSessionEntryRows(
  database: Pick<OpenClawAgentDatabase, "db">,
  projection: SessionEntryProjection | "delivery",
) {
  if (projection === "delivery") {
    // Preserve raw JSON strings, including escaped surrogates. Duplicate keys, overdepth
    // JSON and literal NUL retain the existing parser's semantics through the fallback.
    const deliveryJson =
      /* kysely-allow-raw: bounded delivery projection of exact session rows. */ sql<string>`
      CASE WHEN json_valid(entry_json)
        AND json_type(entry_json, '$.sessionId') = 'text'
        AND json_type(entry_json, '$.updatedAt') IN ('integer', 'real')
        AND length(CAST(entry_json AS BLOB)) = length(CAST(printf('%s', entry_json) AS BLOB))
      THEN (SELECT CASE WHEN count(*) = count(DISTINCT key)
        THEN json_group_object(key, json(entry_json -> fullkey)) ELSE entry_json END
        FROM json_each(entry_json) WHERE key IN ('sessionId', 'updatedAt', 'delivery', 'groupId'))
      ELSE entry_json END`.as("entry_json");
    return getNodeSqliteKysely<OpenClawAgentKyselyDatabase>(database.db)
      .selectFrom("session_nodes")
      .select(["session_key", "current_session_id", "updated_at", deliveryJson]);
  }
  return projection !== "full"
    ? selectSessionEntryRows(database, projection).select(["current_session_id", "updated_at"])
    : getNodeSqliteKysely<OpenClawAgentKyselyDatabase>(database.db)
        .selectFrom("session_nodes")
        .selectAll()
        .select(sessionEntrySnapshotColumnsForKeys(undefined, projection));
}

import type { DatabaseSync } from "node:sqlite";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { sql } from "kysely";
import {
  createSqliteQueryCache,
  getNodeSqliteKysely,
  prepareSqliteQuerySync,
} from "../../infra/kysely-sync.js";
import { parseSqliteTableDefinition } from "../../infra/sqlite-schema-contract-assembly.js";
import {
  getAdmittedSqliteSchemaFacts,
  runSqliteReadOperationSync,
  type SqliteSchemaFacts,
} from "../../infra/sqlite-schema-facts.js";
import { SESSION_OWNER_COLUMN_DEFINITIONS } from "../../state/openclaw-agent-db-additive-columns.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import type { SessionActor } from "./session-entry-provenance.js";
import type { SqliteSessionOwnerRow } from "./session-entry-storage.types.js";
import type { SessionEntry } from "./types.js";

export type { SqliteSessionOwnerRow } from "./session-entry-storage.types.js";

const ownerColumnAvailability = new WeakMap<SqliteSchemaFacts, boolean>();
const rawOwnerColumnRead = createSqliteQueryCache((database) =>
  prepareSqliteQuerySync(database, () =>
    getNodeSqliteKysely<OpenClawAgentKyselyDatabase>(database)
      .selectFrom(sql`pragma_table_info('session_nodes')`.as("pragma_columns"))
      .select(sql`name`.as("name")),
  ),
);

function actorFromColumns(type: unknown, id: unknown): SessionActor | undefined {
  const normalizedType = type === "human" || type === "agent" || type === "system" ? type : null;
  const normalizedId = normalizeOptionalString(id);
  return normalizedType && normalizedId ? { type: normalizedType, id: normalizedId } : undefined;
}

export function readSqliteSessionOwner(row: SqliteSessionOwnerRow): SessionEntry["owner"] {
  const actor = actorFromColumns(row.owner_actor_type, row.owner_actor_id);
  if (!actor) {
    return undefined;
  }
  const assignedBy = actorFromColumns(row.owner_assigned_by_type, row.owner_assigned_by_id);
  const assignedAt =
    typeof row.owner_assigned_at === "number" && Number.isFinite(row.owner_assigned_at)
      ? row.owner_assigned_at
      : undefined;
  return {
    actor,
    ...(assignedBy ? { assignedBy } : {}),
    ...(assignedAt !== undefined ? { assignedAt } : {}),
  };
}

export function projectSqliteSessionOwner(
  entry: SessionEntry,
  row: SqliteSessionOwnerRow,
): SessionEntry {
  const owner = readSqliteSessionOwner(row);
  return owner ? { ...entry, owner } : entry;
}

export function hasSqliteSessionOwnerColumns(database: DatabaseSync): boolean {
  return runSqliteReadOperationSync(database, () => {
    const schema = getAdmittedSqliteSchemaFacts(database);
    if (schema) {
      let available = ownerColumnAvailability.get(schema);
      if (available === undefined) {
        const definition = schema.tableSql.get("session_nodes");
        const columns =
          definition === undefined
            ? undefined
            : parseSqliteTableDefinition(definition, "session_nodes").columns;
        available = SESSION_OWNER_COLUMN_DEFINITIONS.every(({ columnName }) =>
          columns?.has(columnName),
        );
        ownerColumnAvailability.set(schema, available);
      }
      return available;
    }
    // Raw maintenance handles and dynamic authorizers cannot lend retained schema facts.
    const tableInfoRows = rawOwnerColumnRead(database)(undefined).rows;
    const columns = new Set(
      tableInfoRows.flatMap((row) => (typeof row.name === "string" ? [row.name] : [])),
    );
    return SESSION_OWNER_COLUMN_DEFINITIONS.every(({ columnName }) => columns.has(columnName));
  });
}

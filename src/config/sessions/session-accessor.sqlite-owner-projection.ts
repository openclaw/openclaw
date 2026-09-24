import type { DatabaseSync } from "node:sqlite";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { sql } from "kysely";
import { getNodeSqliteKysely, prepareSqliteQuerySync } from "../../infra/kysely-sync.js";
import { getAdmittedSqliteSchemaFacts } from "../../infra/sqlite-schema-facts.js";
import { SESSION_OWNER_COLUMN_DEFINITIONS } from "../../state/openclaw-agent-db-additive-columns.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import type { SessionActor } from "./session-entry-provenance.js";
import type { SessionEntry } from "./types.js";

export type SqliteSessionOwnerRow = {
  owner_actor_type?: string | null;
  owner_actor_id?: string | null;
  owner_assigned_by_type?: string | null;
  owner_assigned_by_id?: string | null;
  owner_assigned_at?: number | null;
};

function prepareOwnerColumnReads(database: DatabaseSync) {
  const db = getNodeSqliteKysely<OpenClawAgentKyselyDatabase>(database);
  return {
    columns: prepareSqliteQuerySync(database, () =>
      db
        .selectFrom(sql`pragma_table_info('session_nodes')`.as("pragma_columns"))
        .select(sql`name`.as("name")),
    ),
  };
}

const ownerColumnAvailability = new WeakMap<
  DatabaseSync,
  ReturnType<typeof prepareOwnerColumnReads> & {
    availability?: { available: boolean; revision: number };
  }
>();

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
  let reads = ownerColumnAvailability.get(database);
  if (!reads) {
    reads = prepareOwnerColumnReads(database);
    ownerColumnAvailability.set(database, reads);
  }
  const revision = getAdmittedSqliteSchemaFacts(database)?.revision;
  const cached = reads.availability;
  if (revision !== undefined && cached?.revision === revision) {
    return cached.available;
  }
  const tableInfoRows = reads.columns(undefined).rows;
  const columns = new Set(
    tableInfoRows.flatMap((row) => (typeof row.name === "string" ? [row.name] : [])),
  );
  const available = SESSION_OWNER_COLUMN_DEFINITIONS.every(({ columnName }) =>
    columns.has(columnName),
  );
  // Raw maintenance handles and dynamic authorizers cannot lend retained schema facts.
  reads.availability = revision === undefined ? undefined : { available, revision };
  return available;
}

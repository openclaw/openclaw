import type { DatabaseSync } from "node:sqlite";
import { admitStoreSearch } from "../infra/database-engine/adapters.js";
import { getDatabaseEngineInput } from "../infra/database-engine/context.js";
import type { SearchSchema, StoreSchema } from "../infra/database-engine/contract.js";
import { openEngineStore } from "../infra/database-engine/open.js";
import { getPostgresPhysicalFacts } from "../infra/database-engine/physical-facts.js";
import {
  isPostgresSqlConnection,
  type EngineConnection,
  type PostgresSqlConnection,
} from "../infra/sql-connection.js";
import { captureSqliteSchemaFacts } from "../infra/sqlite-schema-admission.js";
import { admitSqliteSchema, getAdmittedSqliteSchemaFacts } from "../infra/sqlite-schema-facts.js";
import { VERSION } from "../version.js";
import {
  AGENT_INDEX_RETIREMENT_SCHEMA_VERSION,
  AGENT_MEMORY_REVISION_SCHEMA_VERSION,
  AGENT_VECTOR_DECODER_SCHEMA_VERSION,
  AGENT_VECTOR_SEARCH_SCHEMA_VERSION,
  AGENT_WRITE_LAYOUT_SCHEMA_VERSION,
  AGENT_TRAJECTORY_STORAGE_SCHEMA_VERSION,
  OPENCLAW_AGENT_SCHEMA_VERSION,
} from "./openclaw-agent-db-contract.js";
import { assertAgentDatabaseMaintenanceAuthority } from "./openclaw-agent-db-maintenance-authority.js";
import {
  publishAgentSchemaMetadata,
  readExistingAgentSchemaMeta,
} from "./openclaw-agent-db-metadata.js";
import { assertCurrentAgentSchemaMetadata } from "./openclaw-agent-db-schema-read.js";
import {
  AGENT_INDEX_RETIREMENT_SQL,
  withLegacyAgentPostgresIndexes,
} from "./openclaw-agent-index-retirement-migration.js";
import {
  AGENT_MEMORY_REVISION_POSTGRES_SQL,
  withLegacyAgentPostgresMemoryRevisionTriggers,
} from "./openclaw-agent-memory-revision-migration.js";
import { agentTranscriptSearchSchema } from "./openclaw-agent-search-schema.js";
import {
  AGENT_TRAJECTORY_STORAGE_POSTGRES_MIGRATION_SQL,
  withLegacyAgentPostgresTrajectoryStorage,
} from "./openclaw-agent-trajectory-storage-migration.js";
import { AGENT_VECTOR_DECODER_POSTGRES_SQL } from "./openclaw-agent-vector-decoder-migration.js";
import { AGENT_VECTOR_SEARCH_POSTGRES_SQL } from "./openclaw-agent-vector-search-migration.js";
import {
  AGENT_WRITE_LAYOUT_POSTGRES_MIGRATION_SQL,
  withLegacyAgentPostgresWriteLayout,
} from "./openclaw-agent-write-layout-migration.js";
import { agentPostgresRuntime } from "./postgres-schema.generated/agent-runtime.js";
import { agentSearchPostgresRuntime } from "./postgres-schema.generated/agent-search-runtime.js";

export function agentEngineInput() {
  return getDatabaseEngineInput("agent");
}

/** Enabled features prepare their definitions; the agent opener retains DDL custody. */
export function admitAgentEngineSearchExtensions(
  db: EngineConnection,
  definitions: Readonly<Record<string, SearchSchema>>,
  admit: (stage: "transaction" | "commit") => void,
): void {
  if (!isPostgresSqlConnection(db)) {
    return;
  }
  db.runTransaction(
    () => {
      admit("transaction");
      for (const [name, definition] of Object.entries(definitions)) {
        admitStoreSearch(db, definition, { extension: name });
      }
    },
    {
      withCommit: (commit) => {
        admit("commit");
        commit();
      },
    },
  );
}

const agentPostgresSql = `${agentPostgresRuntime.sql}\n${agentSearchPostgresRuntime.sql}`;
const agentPostgresV30Sql = withLegacyAgentPostgresMemoryRevisionTriggers(agentPostgresSql);
const agentPostgresV29Sql = withLegacyAgentPostgresTrajectoryStorage(agentPostgresV30Sql);
const agentPostgresV28Sql = withLegacyAgentPostgresIndexes(agentPostgresV29Sql);

export const agentEngineSchema: StoreSchema = {
  id: "agent",
  version: OPENCLAW_AGENT_SCHEMA_VERSION,
  sqlite: "",
  postgres: agentPostgresSql,
  postgresVectorDecoderVersion: 2,
  postgresVectorSearchVersion: 2,
  search: agentTranscriptSearchSchema,
  postgresMigrations: [
    {
      version: AGENT_WRITE_LAYOUT_SCHEMA_VERSION,
      fromSchema: { postgres: withLegacyAgentPostgresWriteLayout(agentPostgresV28Sql) },
      schema: { postgres: agentPostgresV28Sql },
      sql: `${AGENT_WRITE_LAYOUT_POSTGRES_MIGRATION_SQL}
        UPDATE schema_meta
        SET schema_version = ${AGENT_WRITE_LAYOUT_SCHEMA_VERSION},
          app_version = '${VERSION.replaceAll("'", "''")}',
          updated_at = CAST(EXTRACT(EPOCH FROM CURRENT_TIMESTAMP) * 1000 AS bigint)
        WHERE meta_key = 'primary';`,
    },
    {
      version: AGENT_INDEX_RETIREMENT_SCHEMA_VERSION,
      fromSchema: { postgres: agentPostgresV28Sql },
      schema: { postgres: agentPostgresV29Sql },
      sql: `${AGENT_INDEX_RETIREMENT_SQL}
        ALTER FUNCTION openclaw_transcript_navigation_check(text)
          STRICT SET search_path = pg_catalog;
        UPDATE schema_meta
        SET schema_version = ${AGENT_INDEX_RETIREMENT_SCHEMA_VERSION},
          app_version = '${VERSION.replaceAll("'", "''")}',
          updated_at = CAST(EXTRACT(EPOCH FROM CURRENT_TIMESTAMP) * 1000 AS bigint)
        WHERE meta_key = 'primary';`,
    },
    {
      version: AGENT_TRAJECTORY_STORAGE_SCHEMA_VERSION,
      fromSchema: { postgres: agentPostgresV29Sql },
      schema: { postgres: agentPostgresV30Sql },
      sql: `${AGENT_TRAJECTORY_STORAGE_POSTGRES_MIGRATION_SQL}
        UPDATE schema_meta
        SET schema_version = ${AGENT_TRAJECTORY_STORAGE_SCHEMA_VERSION},
          app_version = '${VERSION.replaceAll("'", "''")}',
          updated_at = CAST(EXTRACT(EPOCH FROM CURRENT_TIMESTAMP) * 1000 AS bigint)
        WHERE meta_key = 'primary';`,
    },
    {
      version: AGENT_MEMORY_REVISION_SCHEMA_VERSION,
      fromSchema: { postgres: agentPostgresV30Sql },
      schema: { postgres: agentPostgresSql },
      sql: `${AGENT_MEMORY_REVISION_POSTGRES_SQL}
        UPDATE schema_meta
        SET schema_version = ${AGENT_MEMORY_REVISION_SCHEMA_VERSION},
          app_version = '${VERSION.replaceAll("'", "''")}',
          updated_at = CAST(EXTRACT(EPOCH FROM CURRENT_TIMESTAMP) * 1000 AS bigint)
        WHERE meta_key = 'primary';`,
    },
    {
      version: AGENT_VECTOR_DECODER_SCHEMA_VERSION,
      fromSchema: { postgres: agentPostgresSql },
      schema: { postgres: agentPostgresSql, postgresVectorDecoderVersion: 2 },
      sql: `${AGENT_VECTOR_DECODER_POSTGRES_SQL}
        UPDATE schema_meta
        SET schema_version = ${AGENT_VECTOR_DECODER_SCHEMA_VERSION},
          app_version = '${VERSION.replaceAll("'", "''")}',
          updated_at = CAST(EXTRACT(EPOCH FROM CURRENT_TIMESTAMP) * 1000 AS bigint)
        WHERE meta_key = 'primary';`,
    },
    {
      version: AGENT_VECTOR_SEARCH_SCHEMA_VERSION,
      fromSchema: { postgres: agentPostgresSql, postgresVectorDecoderVersion: 2 },
      schema: {
        postgres: agentPostgresSql,
        postgresVectorDecoderVersion: 2,
        postgresVectorSearchVersion: 2,
      },
      sql: `${AGENT_VECTOR_SEARCH_POSTGRES_SQL}
        UPDATE schema_meta
        SET schema_version = ${AGENT_VECTOR_SEARCH_SCHEMA_VERSION},
          app_version = '${VERSION.replaceAll("'", "''")}',
          updated_at = CAST(EXTRACT(EPOCH FROM CURRENT_TIMESTAMP) * 1000 AS bigint)
        WHERE meta_key = 'primary';`,
    },
  ],
};

function admitAgentPostgres(
  db: PostgresSqlConnection,
  agentId: string | undefined,
  pathname: string,
  fresh: boolean,
) {
  if (fresh) {
    if (agentId === undefined) {
      throw new Error("Creating an agent database requires an agent owner");
    }
    const now = Date.now();
    // sqlite-allow-raw: PostgreSQL schema bootstrap seeds the canonical singleton row.
    db.exec("INSERT INTO session_key_contract (id, main_key, updated_at) VALUES (1, 'main', 0)");
    // sqlite-allow-raw: PostgreSQL schema bootstrap seeds the canonical singleton row.
    db.exec("INSERT INTO memory_index_state (id, revision) VALUES (1, 0)");
    // sqlite-allow-raw: PostgreSQL schema bootstrap records its initial owner and version.
    db.prepare(`INSERT INTO schema_meta
      (meta_key, role, schema_version, agent_id, app_version, created_at, updated_at)
      VALUES ('primary', 'agent', ?, ?, ?, ?, ?)`).run(
      OPENCLAW_AGENT_SCHEMA_VERSION,
      agentId,
      VERSION,
      now,
      now,
    );
    publishAgentSchemaMetadata(db, {
      agentId,
      role: "agent",
      schemaVersion: OPENCLAW_AGENT_SCHEMA_VERSION,
    });
  }
  const metadata = readExistingAgentSchemaMeta(db);
  assertCurrentAgentSchemaMetadata(
    metadata,
    agentId ?? metadata?.agentId ?? "",
    pathname,
    agentEngineSchema.version,
  );
  if (getPostgresPhysicalFacts(db)?.version !== agentEngineSchema.version) {
    throw new Error("Agent database has no current PostgreSQL schema admission");
  }
  // Nested worker writes must see the identity anchor's completed native admission.
  admitSqliteSchema(db.anchor);
}

/** The existing agent owner retains the anchor and all execution/close custody. */
export function openAgentEngineStore(
  anchor: DatabaseSync,
  agentId: string | undefined,
  pathname: string,
  existingOnly = false,
  closeOnFailure?: (db: PostgresSqlConnection, error: unknown) => never,
) {
  if (agentId === undefined && !existingOnly) {
    throw new Error("Creating an agent database requires an agent owner");
  }
  return openEngineStore({
    anchor,
    schema: agentEngineSchema,
    input: agentEngineInput(),
    existingOnly,
    closeOnFailure,
    assertMigrationCurrent: assertAgentDatabaseMaintenanceAuthority,
    prepareAnchor: () => {},
    openSqlite: () => {},
    inspectSqlite: () => {
      const facts = getAdmittedSqliteSchemaFacts(anchor) ?? captureSqliteSchemaFacts(anchor);
      return {
        hasEngineAnchor: facts.tables.has("openclaw_engine_anchor"),
        hasExistingData: [...facts.tables, ...facts.views, ...facts.triggers.keys()].some(
          (name) => name !== "openclaw_engine_anchor" && !name.startsWith("sqlite_"),
        ),
      };
    },
    admitPostgres: (db, fresh) => admitAgentPostgres(db, agentId, pathname, fresh),
  });
}

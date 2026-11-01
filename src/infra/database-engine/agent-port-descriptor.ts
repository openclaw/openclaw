import { isDeepStrictEqual } from "node:util";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { MEMORY_PATH_POSTGRES_INDEXES } from "../../../packages/memory-host-sdk/src/host/memory-path-postgres.js";
import {
  memoryStandingIntentSearchSchema,
  memoryTextSearchSchema,
  memoryVectorSearchSchema,
} from "../../../packages/memory-host-sdk/src/host/memory-search-schema.js";
import { readTranscriptPayload } from "../../config/sessions/transcript-payload.js";
import { deriveTranscriptPredicateFields } from "../../config/sessions/transcript-predicate-fields.js";
import { withoutAgentPostgresColdArchiveChunks } from "../../state/openclaw-agent-cold-archive-chunks-schema.js";
import { withoutAgentPostgresColdNavigation } from "../../state/openclaw-agent-cold-navigation-schema.js";
import { FIRST_USE_ADDITIVE_AGENT_COLUMN_DEFINITIONS } from "../../state/openclaw-agent-db-additive-columns.js";
import {
  AGENT_COLD_ARCHIVE_CHUNKS_SCHEMA_VERSION,
  AGENT_MEMORY_REVISION_SCHEMA_VERSION,
  AGENT_VECTOR_DECODER_SCHEMA_VERSION,
  AGENT_TEXT_SEARCH_SCHEMA_VERSION,
  AGENT_VECTOR_SEARCH_SCHEMA_VERSION,
  OPENCLAW_AGENT_SCHEMA_VERSION,
} from "../../state/openclaw-agent-db-contract.js";
import { agentEngineSchema, openAgentEngineStore } from "../../state/openclaw-agent-db-engine.js";
import { runWithAgentDatabaseMaintenanceAuthority } from "../../state/openclaw-agent-db-lease.js";
import { AGENT_SCHEMA_COMPATIBILITY } from "../../state/openclaw-agent-db-schema-compatibility.js";
import {
  assertExistingAgentSchemaOwner,
  assertOpenClawAgentSchemaContains,
  assertSupportedAgentSchemaVersion,
  getOpenClawAgentMigrationSchema,
  hasPendingCurrentVersionAgentDatabaseMigration,
  readExistingAgentSchemaMeta,
} from "../../state/openclaw-agent-db-schema-helpers.js";
import { ensureOpenClawAgentDatabaseSchema } from "../../state/openclaw-agent-db-schema.js";
import type { DB } from "../../state/openclaw-agent-db.generated.js";
import { withLegacyAgentPostgresIndexes } from "../../state/openclaw-agent-index-retirement-migration.js";
import { withLegacyAgentPostgresMemoryPaths } from "../../state/openclaw-agent-memory-path-migration.js";
import {
  LEGACY_MEMORY_REVISION_SQLITE_TRIGGERS,
  withLegacyAgentPostgresMemoryRevisionTriggers,
} from "../../state/openclaw-agent-memory-revision-migration.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "../../state/openclaw-agent-schema.js";
import { agentTranscriptSearchSchema } from "../../state/openclaw-agent-search-schema.js";
import { withLegacyAgentPostgresTrajectoryStorage } from "../../state/openclaw-agent-trajectory-storage-migration.js";
import { withLegacyAgentPostgresWriteLayout } from "../../state/openclaw-agent-write-layout-migration.js";
import { ensureColumn } from "../../state/openclaw-state-db-schema-helpers.js";
import metadata from "../../state/postgres-schema.generated/agent-port.json" with { type: "json" };
import { agentPostgresRuntime } from "../../state/postgres-schema.generated/agent-runtime.js";
import { agentSearchPostgresRuntime } from "../../state/postgres-schema.generated/agent-search-runtime.js";
import manifest from "../../state/postgres-schema.generated/manifest.json" with { type: "json" };
import { readTrajectoryPayload } from "../../trajectory/runtime-payload.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../kysely-sync.js";
import { openNodeSqliteDatabase } from "../node-sqlite.js";
import { LEGACY_USAGE_COST_PARTITION_SCOPE } from "../session-cost-usage-partitions.js";
import { admitSqliteSchema } from "../sqlite-schema-facts.js";
import { normalizeSchemaSql } from "../sqlite-schema-sql.js";
import { withEngineStoreAdmission } from "./admission-scope.js";
import {
  AGENT_PORT_PROJECTION_TABLES,
  rebuildAgentPortProjections,
} from "./agent-port-projections.js";
import { withDatabaseEngineSelection } from "./context.js";
import type { SearchSchema } from "./contract.js";
import {
  DatabasePortDataError,
  pendingSqliteColumns,
  type PortDescriptor,
  type PortTable,
} from "./port-descriptor.js";
import { withLegacyPostgresIndexOrdering } from "./postgres-index-ordering.js";
import { pgSearchName, postgresSearchSql } from "./postgres-search-schema.js";
import { resolveDatabaseFamilyEngines } from "./registry.js";

const agentSourceSearchPostData: NonNullable<PortDescriptor["postgresSourcePostData"]> = async (
  source,
) => {
  const row = (
    await source.db.query<{ metadata: { version: number; search_extensions?: string | null } }>(
      `SELECT to_jsonb(meta) AS metadata
       FROM ${pgSearchName(source.namespace)}.openclaw_schema_meta AS meta WHERE store = 'agent'`,
    )
  ).rows[0];
  let parsed: unknown;
  try {
    parsed = JSON.parse(row?.metadata.search_extensions ?? "{}");
  } catch {
    throw new DatabasePortDataError("Malformed agent search-extension metadata");
  }
  const definitions = asOptionalRecord(parsed);
  if (!definitions) {
    throw new DatabasePortDataError("Invalid agent search-extension metadata");
  }
  const schemas: SearchSchema[] = [];
  for (const [name, definition] of Object.entries(definitions)) {
    const value = asOptionalRecord(definition);
    let expected: SearchSchema | undefined;
    if (name === "memory.text") {
      const body = asOptionalRecord(asOptionalRecord(value?.text)?.body);
      const mode = asOptionalRecord(body?.postgres)?.mode;
      expected = memoryTextSearchSchema(mode === "trigram" ? "trigram" : "unicode61");
    } else if (name === "memory.standing-intents") {
      expected = memoryStandingIntentSearchSchema;
    } else if (name === "memory.vector") {
      const chunks = asOptionalRecord(asOptionalRecord(value?.vector)?.chunks);
      const dimensions = asOptionalRecord(chunks?.postgres)?.dimensions;
      if (
        typeof dimensions === "number" &&
        Number.isInteger(dimensions) &&
        dimensions >= 1 &&
        dimensions <= 16_000
      ) {
        expected = memoryVectorSearchSchema(dimensions);
      }
    }
    if (!expected || !isDeepStrictEqual(definition, expected)) {
      throw new DatabasePortDataError(
        "Unknown or changed agent search extension; matching memory owner required",
      );
    }
    schemas.push(expected);
  }
  if (!schemas.length) {
    return undefined;
  }
  return (namespace) => {
    const shared = { text: true, vector: false };
    return schemas
      .map((schema) => {
        const sql = postgresSearchSql(
          schema,
          namespace,
          shared,
          row!.metadata.version >= AGENT_VECTOR_DECODER_SCHEMA_VERSION ? 2 : 1,
          row!.metadata.version >= AGENT_VECTOR_SEARCH_SCHEMA_VERSION ? 2 : 1,
          row!.metadata.version >= AGENT_TEXT_SEARCH_SCHEMA_VERSION ? 2 : 1,
        );
        shared.vector ||= Object.keys(schema.vector ?? {}).length > 0;
        return sql;
      })
      .join("\n;\n");
  };
};

export async function loadAgentPortDescriptor(
  sourceVersion = agentEngineSchema.version,
): Promise<PortDescriptor> {
  if (sourceVersion !== agentEngineSchema.version) {
    const backup = agentEngineSchema.postgresMigrations?.find(
      (step) => step.version === sourceVersion + 1,
    )?.backup;
    if (backup?.version === sourceVersion && backup.id === "agent") {
      return backup;
    }
    // Schema 30 appends columns; 31–36 and 38 change only PostgreSQL search, triggers, or indexes.
    // Schema 37 adds a cold archive companion table; 39 relaxes the transcript payload CHECK.
    // Pin the remaining shared layout so future DDL gets its own descriptor.
    if (
      backup ||
      OPENCLAW_AGENT_SCHEMA_VERSION !== 39 ||
      ![27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38].includes(sourceVersion)
    ) {
      throw new DatabasePortDataError(
        `Missing agent PostgreSQL backup descriptor for version ${sourceVersion}`,
      );
    }
  }
  const isColumn = (
    fact: (typeof agentPostgresRuntime.expectedCatalog)[number],
  ): fact is typeof fact & { value: PortTable["columns"][number] } => fact.kind === "column";
  const historical = sourceVersion !== agentEngineSchema.version;
  const legacyColdArchive = sourceVersion < AGENT_COLD_ARCHIVE_CHUNKS_SCHEMA_VERSION;
  const legacyTrajectory = sourceVersion < 30;
  const catalog = agentPostgresRuntime.expectedCatalog.filter(
    (fact) =>
      !(legacyColdArchive && fact.table === "session_transcript_cold_archive_chunks") &&
      (!legacyTrajectory ||
        fact.table !== "trajectory_runtime_events" ||
        !isColumn(fact) ||
        !["event_utf8_bytes", "event_payload", "event_codec"].includes(fact.value.name)),
  );
  const columns = catalog.filter(isColumn);
  const keys = catalog.filter(
    (fact): fact is typeof fact & { value: string[] } => fact.kind === "primaryKey",
  );
  const descriptor: PortDescriptor = {
    id: "agent",
    version: OPENCLAW_AGENT_SCHEMA_VERSION,
    minimumPostgresVersion: manifest.minimumPostgresVersion,
    sqlite: OPENCLAW_AGENT_SCHEMA_SQL.replace(/^INSERT OR IGNORE INTO[^;]+;/gm, ""),
    tables: [
      ...metadata.tables
        .filter(
          ({ name }) => !(legacyColdArchive && name === "session_transcript_cold_archive_chunks"),
        )
        .map(({ name, identities }) => ({
          name,
          identities,
          columns: columns
            .filter((fact) => fact.table === name)
            .map((fact) => ({ name: fact.value.name, type: fact.value.type })),
          pk: keys.find((fact) => fact.table === name)?.value ?? [],
        })),
      ...metadata.sqliteTables,
    ],
    triggers: metadata.triggers.map(({ name, table, range }) => ({
      name,
      table,
      sql: OPENCLAW_AGENT_SCHEMA_SQL.slice(range[0], range[1])
        .replace("IF NOT EXISTS ", "")
        .replace(/;$/, ""),
    })),
    preData: agentPostgresRuntime.sql.slice(...metadata.preData) + agentSearchPostgresRuntime.sql,
    omittedSqliteTriggers: AGENT_SCHEMA_COMPATIBILITY.optionalCanonicalTriggerGroups.flatMap(
      (group) =>
        group.triggers.map((trigger) => ({
          name: trigger.name,
          table: group.tableName,
          sql: normalizeSchemaSql(trigger.sql.replace("main.", ""))!,
        })),
    ),
    // Validate at the destination before indexes can give duplicate JSON members new semantics.
    postData:
      `DO $voice$ DECLARE cache_key text; BEGIN
      SELECT key INTO cache_key FROM cache_entries WHERE scope = 'talk-client-voice-sessions'
        AND value_json IS JSON AND NOT (value_json IS JSON WITH UNIQUE KEYS) LIMIT 1;
      IF FOUND THEN RAISE EXCEPTION 'Agent port refused duplicate-key voice JSON; cache key SHA-256 %',
        encode(sha256(convert_to(cache_key, 'UTF8')), 'hex')
        USING HINT = 'Repair through the voice store owner.'; END IF;
    END $voice$;\n` + agentPostgresRuntime.sql.slice(...metadata.postData),
    postgresPostData: (namespace) =>
      postgresSearchSql(
        agentTranscriptSearchSchema,
        namespace,
        {},
        1,
        1,
        sourceVersion >= AGENT_TEXT_SEARCH_SCHEMA_VERSION ? 2 : 1,
      ),
    postgresSourcePostData: agentSourceSearchPostData,
    postgresDerivedTables: ["session_transcript_fts"],
    expectedCatalog: catalog,
    projections: [
      {
        tables: [
          ...AGENT_PORT_PROJECTION_TABLES,
          ...metadata.sqliteTables.map((table) => table.name),
          ...AGENT_PORT_PROJECTION_TABLES.flatMap((name) =>
            // FTS5 and the single-column sqlite-vec accelerator own these auxiliary tables.
            [
              "_data",
              "_idx",
              "_content",
              "_docsize",
              "_config",
              "_info",
              "_chunks",
              "_rowids",
              "_vector_chunks00",
            ].map((suffix) => name + suffix),
          ),
        ],
        rebuild: rebuildAgentPortProjections,
      },
    ],
    decodeSqlite: {
      trajectory_runtime_events(row) {
        if (row.event_codec == null) {
          return row;
        }
        if (!(row.event_payload instanceof Uint8Array) || typeof row.event_codec !== "string") {
          throw new DatabasePortDataError("Invalid compressed trajectory payload");
        }
        return {
          ...row,
          event_json: readTrajectoryPayload({
            event_json: "",
            event_payload: row.event_payload,
            event_codec: row.event_codec,
            event_utf8_bytes: Number(row.event_utf8_bytes),
          }),
          event_payload: null,
          event_codec: null,
        };
      },
      transcript_events(row) {
        let decoded = row;
        if (row.event_zstd != null) {
          if (!(row.event_zstd instanceof Uint8Array)) {
            throw new DatabasePortDataError("Invalid compressed transcript payload");
          }
          decoded = {
            ...row,
            event_json: readTranscriptPayload({
              event_json: null,
              event_zstd: row.event_zstd,
              event_utf8_bytes: Number(row.event_utf8_bytes),
            }),
            event_zstd: null,
          };
        }
        // SQLite upgrades leave old predicates lazy; PostgreSQL reads stored facts.
        // The port already holds this canonical payload, so no extra read is needed.
        return decoded.navigation_type == null &&
          decoded.navigation_valid !== 0 &&
          decoded.navigation_valid !== 0n &&
          typeof decoded.event_json === "string"
          ? { ...decoded, ...deriveTranscriptPredicateFields(decoded.event_json) }
          : decoded;
      },
    },
    inspectSqliteSource(db) {
      admitSqliteSchema(db);
      const owner = readExistingAgentSchemaMeta(db);
      if (!owner?.agentId) {
        throw new DatabasePortDataError("Agent port requires schema ownership metadata");
      }
      assertExistingAgentSchemaOwner(owner, owner.agentId, "agent port source");
      const version = assertSupportedAgentSchemaVersion(db, "agent port source");
      if (owner.schemaVersion !== version) {
        throw new DatabasePortDataError(
          "Agent schema markers disagree; run openclaw doctor --fix before porting",
        );
      }
      const needsIndexRepair = assertOpenClawAgentSchemaContains(
        db,
        "agent port source",
        getOpenClawAgentMigrationSchema(version),
        version < 23 ? "legacy" : "current",
        true,
      );
      const hasRetiredUsagePartitions = executeSqliteQueryTakeFirstSync(
        db,
        getNodeSqliteKysely<Pick<DB, "cache_entries">>(db)
          .selectFrom("cache_entries")
          .select("scope")
          .where("scope", "=", LEGACY_USAGE_COST_PARTITION_SCOPE)
          .limit(1),
      );
      return {
        version,
        migrationRequired:
          version !== OPENCLAW_AGENT_SCHEMA_VERSION ||
          needsIndexRepair ||
          Boolean(hasRetiredUsagePartitions) ||
          hasPendingCurrentVersionAgentDatabaseMigration(db),
        pendingColumns: pendingSqliteColumns(db, FIRST_USE_ADDITIVE_AGENT_COLUMN_DEFINITIONS),
      };
    },
    async migrateSqliteSource(file, _version, assertCurrent) {
      using db = openNodeSqliteDatabase(file);
      const agentId = readExistingAgentSchemaMeta(db)?.agentId;
      if (!agentId) {
        throw new DatabasePortDataError("Private agent copy has no owner");
      }
      await withDatabaseEngineSelection(
        { effectiveEngines: resolveDatabaseFamilyEngines({ database: { engine: "sqlite" } }) },
        () =>
          runWithAgentDatabaseMaintenanceAuthority(
            {
              signal: new AbortController().signal,
              assertCurrent,
              assertOwned: assertCurrent,
              assertOwnedInTransaction: assertCurrent,
              renew: assertCurrent,
            },
            file,
            async () => {
              ensureOpenClawAgentDatabaseSchema(db, { agentId, register: false });
              for (const {
                tableName,
                columnName,
                dataType,
              } of FIRST_USE_ADDITIVE_AGENT_COLUMN_DEFINITIONS) {
                ensureColumn(db, tableName, `${columnName} ${dataType}`);
              }
              // Retired partitions are rebuilt from retained transcripts; their NUL keys cannot port.
              executeSqliteQuerySync(
                db,
                getNodeSqliteKysely<Pick<DB, "cache_entries">>(db)
                  .deleteFrom("cache_entries")
                  .where("scope", "=", LEGACY_USAGE_COST_PARTITION_SCOPE),
              );
            },
          ),
      );
    },
    async admit(file, input) {
      withDatabaseEngineSelection(
        {
          effectiveEngines: resolveDatabaseFamilyEngines({
            database: { engine: input ? "postgres" : "sqlite" },
          }),
          postgres: input,
        },
        () =>
          withEngineStoreAdmission(() => {
            using anchor = openNodeSqliteDatabase(file);
            if (input) {
              const selected = openAgentEngineStore(anchor, undefined, file, true);
              if (selected !== anchor) {
                selected.close();
              }
            } else {
              const agentId = readExistingAgentSchemaMeta(anchor)?.agentId;
              if (!agentId) {
                throw new DatabasePortDataError("Restored agent has no owner");
              }
              assertOpenClawAgentSchemaContains(anchor, file, OPENCLAW_AGENT_SCHEMA_SQL);
            }
          }),
      );
    },
  };
  if (!historical) {
    return descriptor;
  }
  const legacyRevision = sourceVersion < AGENT_MEMORY_REVISION_SCHEMA_VERSION;
  const withoutLegacyColdArchive = (sql: string) =>
    legacyColdArchive ? withoutAgentPostgresColdArchiveChunks(sql) : sql;
  let postData = legacyRevision
    ? withLegacyAgentPostgresMemoryRevisionTriggers(descriptor.postData)
    : descriptor.postData;
  if (sourceVersion < 36) {
    postData = withLegacyAgentPostgresMemoryPaths(postData);
  }
  if (sourceVersion < 35) {
    postData = withLegacyPostgresIndexOrdering(
      postData,
      sourceVersion === 34 ? "schema-nullability" : "sqlite",
      descriptor.preData,
    );
  }
  if (legacyTrajectory) {
    postData = withLegacyAgentPostgresTrajectoryStorage(postData);
  }
  if (sourceVersion < 29) {
    postData = withLegacyAgentPostgresIndexes(postData);
  }
  if (sourceVersion < 28) {
    postData = withLegacyAgentPostgresWriteLayout(postData);
  }
  return {
    ...descriptor,
    version: sourceVersion,
    sqlite: getOpenClawAgentMigrationSchema(sourceVersion).replace(
      /^INSERT OR IGNORE INTO[^;]+;/gm,
      "",
    ),
    triggers: [
      ...(descriptor.triggers ?? []),
      ...(legacyRevision
        ? LEGACY_MEMORY_REVISION_SQLITE_TRIGGERS.map((trigger) => ({
            name: trigger.name,
            table: trigger.table,
            sql: trigger.sql.replace("IF NOT EXISTS ", "").replace(/;$/, ""),
          }))
        : []),
    ],
    preData: withoutAgentPostgresColdNavigation(
      withoutLegacyColdArchive(
        legacyTrajectory
          ? withLegacyAgentPostgresTrajectoryStorage(descriptor.preData)
          : descriptor.preData,
      ),
    ),
    postData: withoutLegacyColdArchive(postData),
    expectedCatalog: catalog.map((fact) =>
      sourceVersion < 36 && fact.kind === "indexes" && fact.table === "memory_index_sources"
        ? {
            table: fact.table,
            kind: fact.kind,
            value: Number(fact.value) - MEMORY_PATH_POSTGRES_INDEXES.length,
          }
        : sourceVersion < 29 &&
            fact.kind === "indexes" &&
            (fact.table === "session_nodes" || fact.table === "session_reactions")
          ? { table: fact.table, kind: fact.kind, value: Number(fact.value) + 1 }
          : sourceVersion < 28 &&
              fact.table === "transcript_event_identities" &&
              fact.kind === "indexes"
            ? { table: fact.table, kind: fact.kind, value: 5 }
            : fact,
    ),
    inspectSqliteSource: undefined,
    migrateSqliteSource: undefined,
    admit: undefined,
  };
}

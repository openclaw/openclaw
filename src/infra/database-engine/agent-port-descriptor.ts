import { isDeepStrictEqual } from "node:util";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import {
  memoryStandingIntentSearchSchema,
  memoryTextSearchSchema,
  memoryVectorSearchSchema,
} from "../../../packages/memory-host-sdk/src/host/memory-search-schema.js";
import { readTranscriptPayload } from "../../config/sessions/transcript-payload.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../../state/openclaw-agent-db-contract.js";
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
import { OPENCLAW_AGENT_SCHEMA_SQL } from "../../state/openclaw-agent-schema.js";
import { agentTranscriptSearchSchema } from "../../state/openclaw-agent-search-schema.js";
import { withLegacyAgentPostgresWriteLayout } from "../../state/openclaw-agent-write-layout-migration.js";
import metadata from "../../state/postgres-schema.generated/agent-port.json" with { type: "json" };
import { agentPostgresRuntime } from "../../state/postgres-schema.generated/agent-runtime.js";
import { agentSearchPostgresRuntime } from "../../state/postgres-schema.generated/agent-search-runtime.js";
import manifest from "../../state/postgres-schema.generated/manifest.json" with { type: "json" };
import { openNodeSqliteDatabase } from "../node-sqlite.js";
import { admitSqliteSchema } from "../sqlite-schema-facts.js";
import { normalizeSchemaSql } from "../sqlite-schema-sql.js";
import { withEngineStoreAdmission } from "./admission-scope.js";
import {
  AGENT_PORT_PROJECTION_TABLES,
  rebuildAgentPortProjections,
} from "./agent-port-projections.js";
import { withDatabaseEngineSelection } from "./context.js";
import type { SearchSchema } from "./contract.js";
import { DatabasePortDataError, type PortDescriptor, type PortTable } from "./port-descriptor.js";
import { pgSearchName, postgresSearchSql } from "./postgres-search-schema.js";
import { resolveDatabaseFamilyEngines } from "./registry.js";

const agentSourceSearchPostData: NonNullable<PortDescriptor["postgresSourcePostData"]> = async (
  source,
) => {
  const row = (
    await source.db.query<{ metadata: { search_extensions?: string | null } }>(
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
        const sql = postgresSearchSql(schema, namespace, shared);
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
    // v27→28 changes only these indexes in PostgreSQL. Pin the shared table
    // catalog to v28 so later DDL needs its own predecessor descriptor.
    if (backup || OPENCLAW_AGENT_SCHEMA_VERSION !== 28 || sourceVersion !== 27) {
      throw new DatabasePortDataError(
        `Missing agent PostgreSQL backup descriptor for version ${sourceVersion}`,
      );
    }
  }
  const catalog = agentPostgresRuntime.expectedCatalog;
  const columns = catalog.filter(
    (fact): fact is typeof fact & { value: PortTable["columns"][number] } => fact.kind === "column",
  );
  const keys = catalog.filter(
    (fact): fact is typeof fact & { value: string[] } => fact.kind === "primaryKey",
  );
  const descriptor: PortDescriptor = {
    id: "agent",
    version: OPENCLAW_AGENT_SCHEMA_VERSION,
    minimumPostgresVersion: manifest.minimumPostgresVersion,
    sqlite: OPENCLAW_AGENT_SCHEMA_SQL.replace(/^INSERT OR IGNORE INTO[^;]+;/gm, ""),
    tables: [
      ...metadata.tables.map(({ name, identities }) => ({
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
    postgresPostData: (namespace) => postgresSearchSql(agentTranscriptSearchSchema, namespace),
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
      transcript_events(row) {
        if (row.event_zstd == null) {
          return row;
        }
        if (!(row.event_zstd instanceof Uint8Array)) {
          throw new DatabasePortDataError("Invalid compressed transcript payload");
        }
        return {
          ...row,
          event_json: readTranscriptPayload({
            event_json: null,
            event_zstd: row.event_zstd,
            event_utf8_bytes: Number(row.event_utf8_bytes),
          }),
          event_zstd: null,
        };
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
      return {
        version,
        migrationRequired:
          version !== OPENCLAW_AGENT_SCHEMA_VERSION ||
          needsIndexRepair ||
          hasPendingCurrentVersionAgentDatabaseMigration(db),
        pendingColumns: {},
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
              assertOwned: assertCurrent,
              assertOwnedInTransaction: assertCurrent,
              renew: assertCurrent,
            },
            file,
            async () => ensureOpenClawAgentDatabaseSchema(db, { agentId, register: false }),
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
  return sourceVersion === agentEngineSchema.version
    ? descriptor
    : {
        ...descriptor,
        version: sourceVersion,
        sqlite: getOpenClawAgentMigrationSchema(sourceVersion).replace(
          /^INSERT OR IGNORE INTO[^;]+;/gm,
          "",
        ),
        postData: withLegacyAgentPostgresWriteLayout(descriptor.postData),
        expectedCatalog: catalog.map((fact) =>
          fact.table === "transcript_event_identities" && fact.kind === "indexes"
            ? { table: fact.table, kind: fact.kind, value: 5 }
            : fact,
        ),
        inspectSqliteSource: undefined,
        migrateSqliteSource: undefined,
        admit: undefined,
      };
}

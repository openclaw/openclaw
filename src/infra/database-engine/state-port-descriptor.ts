import {
  DOCTOR_OWNED_STATE_TABLES,
  OPENCLAW_STATE_SCHEMA_VERSION,
} from "../../state/openclaw-state-db-contract.js";
import {
  admitStatePostgres,
  inspectStateSqlite,
  stateEngineSchema,
} from "../../state/openclaw-state-db-engine.js";
import { assertOpenClawStateDatabaseForMaintenance } from "../../state/openclaw-state-db-maintenance.js";
import { ensureAgentDeletionJournalPhaseSchema } from "../../state/openclaw-state-db-schema-additive.js";
import { tableHasColumn } from "../../state/openclaw-state-db-schema-helpers.js";
import { withLegacyStateHeadLayout } from "../../state/openclaw-state-db-schema-v26-layout.js";
import { withLegacyStateWriteIndexes } from "../../state/openclaw-state-db-schema-v27-indexes.js";
import { withLegacyPublicationDraft } from "../../state/openclaw-state-db-schema-v28-publication.js";
import { listOpenClawStateFeatureSchemas } from "../../state/openclaw-state-feature-schema.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "../../state/openclaw-state-schema.js";
import manifest from "../../state/postgres-schema.generated/manifest.json" with { type: "json" };
import { statePostgresRuntime } from "../../state/postgres-schema.generated/runtime.js";
import metadata from "../../state/postgres-schema.generated/state-port.json" with { type: "json" };
import { CLIENT_CREDENTIAL_LEGACY_TABLES_SQL } from "../client-credential-schema.js";
import { openNodeSqliteDatabase } from "../node-sqlite.js";
import { admitSqliteSchema, getAdmittedSqliteSchemaFacts } from "../sqlite-schema-facts.js";
import { extractSqliteTableSchema } from "../sqlite-schema-sql.js";
import { withEngineStoreAdmission } from "./admission-scope.js";
import { openEngineStore } from "./open.js";
import { DatabasePortDataError, type PortDescriptor, type PortTable } from "./port-descriptor.js";

export async function loadStatePortDescriptor(
  sourceVersion = OPENCLAW_STATE_SCHEMA_VERSION,
): Promise<PortDescriptor> {
  if (sourceVersion !== OPENCLAW_STATE_SCHEMA_VERSION) {
    const backup = stateEngineSchema.postgresMigrations?.find(
      (step) => step.version === sourceVersion + 1,
    )?.backup;
    if (backup?.version === sourceVersion && backup.id === "state") {
      return backup;
    }
    // v28 appends publication draft choices; v24-v26 additionally retain older indexes.
    // Pin these predecessor shapes so later column changes need their own descriptor.
    if (
      backup ||
      OPENCLAW_STATE_SCHEMA_VERSION !== 29 ||
      ![24, 25, 26, 27, 28].includes(sourceVersion)
    ) {
      throw new DatabasePortDataError(
        `Missing shared-state PostgreSQL backup descriptor for version ${sourceVersion}`,
      );
    }
  }
  const source =
    sourceVersion !== OPENCLAW_STATE_SCHEMA_VERSION
      ? statePostgresRuntime.clientCredentialSource
      : undefined;
  // The generated catalog owns these tagged facts; project only the copy fields.
  const isColumn = (
    fact: (typeof statePostgresRuntime.expectedCatalog)[number],
  ): fact is typeof fact & { value: PortTable["columns"][number] } => fact.kind === "column";
  const historical = sourceVersion < 28;
  const catalog = [
    ...statePostgresRuntime.expectedCatalog,
    ...(source?.expectedCatalog ?? []),
  ].filter(
    (fact) =>
      !historical ||
      !isColumn(fact) ||
      fact.value.name !== "draft" ||
      ![
        "github_publication_requests",
        "github_personal_publication_requests",
        "github_repository_publication_requests",
      ].includes(fact.table),
  );
  const columns = catalog.filter(isColumn);
  const keys = catalog.filter(
    (fact): fact is typeof fact & { value: string[] } => fact.kind === "primaryKey",
  );
  const schema = (
    entry: Omit<typeof metadata, "fragments" | "sqliteRanges">,
    postgres: string,
    sqlite: string,
  ) => {
    const names = new Set(entry.tables.map((table) => table.name));
    return {
      sqlite: historical ? withLegacyPublicationDraft(sqlite) : sqlite,
      tables: entry.tables.map(({ name, identities }) => ({
        name,
        identities,
        columns: columns
          .filter((fact) => fact.table === name)
          .map((fact) => ({ name: fact.value.name, type: fact.value.type })),
        pk: keys.find((fact) => fact.table === name)?.value ?? [],
      })),
      preData: historical
        ? withLegacyPublicationDraft(postgres.slice(entry.preData[0], entry.preData[1]))
        : postgres.slice(entry.preData[0], entry.preData[1]),
      postData: postgres.slice(entry.postData[0], entry.postData[1]),
      expectedCatalog: catalog.filter((fact) => names.has(fact.table)),
    };
  };
  const sqliteFragments = new Map(
    listOpenClawStateFeatureSchemas().map((fragment) => [fragment.id, fragment.sql()]),
  );
  for (const table of DOCTOR_OWNED_STATE_TABLES) {
    sqliteFragments.set(table, extractSqliteTableSchema(OPENCLAW_STATE_SCHEMA_SQL, table));
  }
  const eager = schema(
    metadata,
    statePostgresRuntime.eagerSql,
    metadata.sqliteRanges
      .map(([start, end]) => OPENCLAW_STATE_SCHEMA_SQL.slice(start, end))
      .join("\n"),
  );
  if (source) {
    const credentials = schema(source, source.sql, CLIENT_CREDENTIAL_LEGACY_TABLES_SQL);
    eager.sqlite += `\n${credentials.sqlite}`;
    eager.preData += `\n${credentials.preData}`;
    eager.postData += `\n${credentials.postData}`;
    eager.tables.push(...credentials.tables);
    eager.expectedCatalog.push(...credentials.expectedCatalog);
  }
  const descriptor: PortDescriptor = {
    id: "state",
    version: sourceVersion,
    minimumPostgresVersion: manifest.minimumPostgresVersion,
    ...eager,
    fragments: metadata.fragments.map((fragment) => {
      const runtime = statePostgresRuntime.fragments.find((entry) => entry.id === fragment.id)!;
      return Object.assign(schema(fragment, runtime.sql, sqliteFragments.get(fragment.id)!), {
        id: fragment.id,
        dependencies: runtime.dependencies,
      });
    }),
    inspectSqliteSource(db) {
      admitSqliteSchema(db);
      const version = getAdmittedSqliteSchemaFacts(db)!.userVersion;
      if (version !== OPENCLAW_STATE_SCHEMA_VERSION) {
        throw new DatabasePortDataError(
          "Shared-state port requires the current schema; run openclaw doctor --fix with the matching version first.",
        );
      }
      assertOpenClawStateDatabaseForMaintenance(db, { pathname: "shared-state port source" });
      const needsPhaseColumn =
        tableHasColumn(db, "agent_deletion_journal", "agent_id") &&
        !tableHasColumn(db, "agent_deletion_journal", "phase");
      const pendingColumns: Record<string, readonly string[]> = needsPhaseColumn
        ? { agent_deletion_journal: ["phase"] }
        : {};
      // First-use columns are valid absent; porting completes them in its private copy.
      return { version, migrationRequired: false, pendingColumns };
    },
    migrateSqliteSource(file, _version, assertCurrent) {
      using db = openNodeSqliteDatabase(file);
      admitSqliteSchema(db);
      if (tableHasColumn(db, "agent_deletion_journal", "agent_id")) {
        assertCurrent();
        ensureAgentDeletionJournalPhaseSchema(db);
      }
    },
    async admit(file, input) {
      // Historical SQLite images use their descriptor; restored PG anchors still
      // require owner admission against the exact predecessor without migrating.
      if (sourceVersion !== OPENCLAW_STATE_SCHEMA_VERSION && !input) {
        return;
      }
      return withEngineStoreAdmission(() => {
        using anchor = openNodeSqliteDatabase(file);
        const selected = openEngineStore({
          anchor,
          schema: stateEngineSchema,
          input,
          inspectSqlite: () => inspectStateSqlite(anchor),
          prepareAnchor: () => {},
          openSqlite: () => assertOpenClawStateDatabaseForMaintenance(anchor, { pathname: file }),
          admitPostgres: admitStatePostgres,
          existingOnly: true,
          existingVersion: sourceVersion !== OPENCLAW_STATE_SCHEMA_VERSION,
        });
        if (selected !== anchor) {
          selected.close();
        }
      });
    },
  };
  if (sourceVersion === OPENCLAW_STATE_SCHEMA_VERSION) {
    return descriptor;
  }
  if (sourceVersion >= 27) {
    return { ...descriptor, inspectSqliteSource: undefined, migrateSqliteSource: undefined };
  }
  const historicalSqlite = withLegacyStateWriteIndexes(descriptor.sqlite);
  const legacyIndexes = statePostgresRuntime.preWriteIndexesV27Sql;
  return {
    ...descriptor,
    sqlite: sourceVersion < 26 ? withLegacyStateHeadLayout(historicalSqlite) : historicalSqlite,
    postData:
      descriptor.postData.replace(
        /CREATE INDEX "idx_state_leases_owner"[^;]+;/u,
        legacyIndexes.state_leases,
      ) +
      legacyIndexes.skill_usage +
      legacyIndexes.acp_replay_events,
    expectedCatalog: descriptor.expectedCatalog.map((fact) =>
      fact.kind === "indexes" &&
      (fact.table === "skill_usage" || fact.table === "acp_replay_events")
        ? { table: fact.table, kind: fact.kind, value: Number(fact.value) + 1 }
        : fact,
    ),
    inspectSqliteSource: undefined,
    migrateSqliteSource: undefined,
  };
}

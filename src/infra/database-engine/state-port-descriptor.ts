import { CLAW_FIRST_USE_ADDITIVE_STATE_COLUMN_DEFINITIONS } from "../../state/openclaw-state-db-additive-columns.js";
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
import { ensureFirstUseAdditiveStateColumnsForStrictMigration } from "../../state/openclaw-state-db-schema-additive.js";
import { withLegacyStateHeadLayout } from "../../state/openclaw-state-db-schema-v26-layout.js";
import { withLegacyStateWriteIndexes } from "../../state/openclaw-state-db-schema-v27-indexes.js";
import { withLegacyPublicationDraft } from "../../state/openclaw-state-db-schema-v28-publication.js";
import { withLegacyLocalWorkspaceManifests } from "../../state/openclaw-state-db-schema-v31-workspace-manifests.js";
import {
  withLegacyLocalWorkspaceCas,
  WORKSPACE_CAS_COLUMNS,
  WORKSPACE_CAS_TABLES,
} from "../../state/openclaw-state-db-schema-v35-workspace-cas.js";
import {
  withLegacyTemplateStateSchema,
  legacyTemplateStateIdentifier,
} from "../../state/openclaw-state-db-schema-v36-template-names.js";
import { withLegacyWorkerResourceReceipts } from "../../state/openclaw-state-db-schema-v37-resource-receipts.js";
import { withLegacyRepositoryDiskAuthority } from "../../state/openclaw-state-db-schema-v38-repository-disk.js";
import { withLegacyWorkerRetention } from "../../state/openclaw-state-db-schema-v39-worker-retention.js";
import { listOpenClawStateFeatureSchemas } from "../../state/openclaw-state-feature-schema.js";
import { RETAINED_STATE_TABLES } from "../../state/openclaw-state-schema-compatibility.js";
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
import {
  DatabasePortDataError,
  pendingSqliteColumns,
  type PortDescriptor,
  type PortTable,
} from "./port-descriptor.js";
import type { PostgresCatalogFact } from "./postgres-catalog.js";
import { withLegacyPostgresIndexOrdering } from "./postgres-index-ordering.js";

function legacyTemplateCatalogValue(value: unknown): unknown {
  if (typeof value === "string") {
    return legacyTemplateStateIdentifier(value);
  }
  if (Array.isArray(value)) {
    return value.map(legacyTemplateCatalogValue);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, legacyTemplateCatalogValue(item)]),
    );
  }
  return value;
}

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
    // v29 removes credential tables; v30 fences policies; v31 adds per-path workspace baselines.
    if (
      backup ||
      OPENCLAW_STATE_SCHEMA_VERSION !== 39 ||
      ![24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38].includes(sourceVersion)
    ) {
      throw new DatabasePortDataError(
        `Missing shared-state PostgreSQL backup descriptor for version ${sourceVersion}`,
      );
    }
  }
  const source = sourceVersion < 29 ? statePostgresRuntime.clientCredentialSource : undefined;
  // The generated catalog owns these tagged facts; project only the copy fields.
  const isColumn = (
    fact: PostgresCatalogFact,
  ): fact is typeof fact & { value: PortTable["columns"][number] } => fact.kind === "column";
  const historical = sourceVersion < 28;
  const legacyWorkspace = sourceVersion < 31;
  const legacyCas = sourceVersion < 35;
  const legacyTemplates = sourceVersion < 36;
  const legacyResourceReceipts = sourceVersion < 37;
  const legacyRepositoryDisk = sourceVersion < 38;
  const legacyRetention = sourceVersion < 39;
  const currentCatalog: PostgresCatalogFact[] = [
    ...statePostgresRuntime.expectedCatalog,
    ...(source?.expectedCatalog ?? []),
  ].filter(
    (fact) =>
      (!legacyRetention ||
        fact.table !== "worker_environments" ||
        !isColumn(fact) ||
        fact.value.name !== "retention_json") &&
      (!legacyRepositoryDisk ||
        !isColumn(fact) ||
        !(
          (fact.table === "session_repository_workspaces" &&
            fact.value.name === "disk_authority_json") ||
          (fact.table === "worker_workspace_pending_results" &&
            fact.value.name === "repository_disk_authority_json")
        )) &&
      (!legacyResourceReceipts ||
        fact.table !== "worker_environments" ||
        !isColumn(fact) ||
        fact.value.name !== "resource_receipt_json") &&
      (!legacyCas ||
        (!WORKSPACE_CAS_TABLES.some((table) => table === fact.table) &&
          (fact.table !== "local_workspace_projections" ||
            !isColumn(fact) ||
            !WORKSPACE_CAS_COLUMNS.some((column) => column === fact.value.name)))) &&
      (!legacyWorkspace ||
        (fact.table !== "local_workspace_manifest_nodes" &&
          (fact.table !== "local_workspace_projections" ||
            !isColumn(fact) ||
            fact.value.name !== "checkpoint_json"))) &&
      (!historical ||
        !isColumn(fact) ||
        fact.value.name !== "draft" ||
        ![
          "github_publication_requests",
          "github_personal_publication_requests",
          "github_repository_publication_requests",
        ].includes(fact.table)),
  );
  const catalog = legacyTemplates
    ? currentCatalog.map((fact) => ({
        ...fact,
        table: legacyTemplateStateIdentifier(fact.table),
        value: legacyTemplateCatalogValue(fact.value),
      }))
    : currentCatalog;
  const columns = catalog.filter(isColumn);
  const keys = catalog.filter(
    (fact): fact is typeof fact & { value: string[] } => fact.kind === "primaryKey",
  );
  const sourceSql = (sql: string, schemaSql = sql) => {
    const retention = legacyRetention ? withLegacyWorkerRetention(sql) : sql;
    const disk = legacyRepositoryDisk ? withLegacyRepositoryDiskAuthority(retention) : retention;
    const receipts = legacyResourceReceipts ? withLegacyWorkerResourceReceipts(disk) : disk;
    const template = legacyTemplates ? withLegacyTemplateStateSchema(receipts) : receipts;
    const cas = legacyCas ? withLegacyLocalWorkspaceCas(template) : template;
    const workspace = legacyWorkspace ? withLegacyLocalWorkspaceManifests(cas) : cas;
    const publication = historical ? withLegacyPublicationDraft(workspace) : workspace;
    return sourceVersion < 33
      ? withLegacyPostgresIndexOrdering(
          publication,
          sourceVersion < 32 ? "sqlite" : "schema-nullability",
          legacyTemplates ? withLegacyTemplateStateSchema(schemaSql) : schemaSql,
        )
      : publication;
  };
  const schema = (
    entry: Omit<typeof metadata, "fragments" | "sqliteRanges">,
    postgres: string,
    sqlite: string,
  ) => {
    const tables = entry.tables
      .map((table) =>
        legacyTemplates ? { ...table, name: legacyTemplateStateIdentifier(table.name) } : table,
      )
      .filter(
        (table) =>
          (!legacyWorkspace || table.name !== "local_workspace_manifest_nodes") &&
          (!legacyCas || !WORKSPACE_CAS_TABLES.some((name) => name === table.name)),
      );
    const names = new Set(tables.map((table) => table.name));
    return {
      sqlite: sourceSql(sqlite),
      tables: tables.map(({ name, identities }) => ({
        name,
        identities,
        columns: columns
          .filter((fact) => fact.table === name)
          .map((fact) => ({ name: fact.value.name, type: fact.value.type })),
        pk: keys.find((fact) => fact.table === name)?.value ?? [],
      })),
      preData: sourceSql(postgres.slice(entry.preData[0], entry.preData[1])),
      postData: sourceSql(postgres.slice(entry.postData[0], entry.postData[1]), postgres),
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
    retainedSqliteTables: RETAINED_STATE_TABLES,
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
      return {
        version,
        migrationRequired: false,
        pendingColumns: pendingSqliteColumns(db, CLAW_FIRST_USE_ADDITIVE_STATE_COLUMN_DEFINITIONS),
      };
    },
    migrateSqliteSource(file, _version, assertCurrent) {
      using db = openNodeSqliteDatabase(file);
      admitSqliteSchema(db);
      assertCurrent();
      ensureFirstUseAdditiveStateColumnsForStrictMigration(db);
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

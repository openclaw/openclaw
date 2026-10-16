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
import { listOpenClawStateFeatureSchemas } from "../../state/openclaw-state-feature-schema.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "../../state/openclaw-state-schema.js";
import manifest from "../../state/postgres-schema.generated/manifest.json" with { type: "json" };
import { statePostgresRuntime } from "../../state/postgres-schema.generated/runtime.js";
import metadata from "../../state/postgres-schema.generated/state-port.json" with { type: "json" };
import { openNodeSqliteDatabase } from "../node-sqlite.js";
import { admitSqliteSchema, getAdmittedSqliteSchemaFacts } from "../sqlite-schema-facts.js";
import { extractSqliteTableSchema } from "../sqlite-schema-sql.js";
import { withEngineStoreAdmission } from "./admission-scope.js";
import { openEngineStore } from "./open.js";
import { DatabasePortDataError, type PortDescriptor, type PortTable } from "./port-descriptor.js";

export async function loadStatePortDescriptor(): Promise<PortDescriptor> {
  const catalog = statePostgresRuntime.expectedCatalog;
  // The generated catalog owns these tagged facts; project only the copy fields.
  const columns = catalog.filter(
    (fact): fact is typeof fact & { value: PortTable["columns"][number] } => fact.kind === "column",
  );
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
      sqlite,
      tables: entry.tables.map(({ name, identities }) => ({
        name,
        identities,
        columns: columns
          .filter((fact) => fact.table === name)
          .map((fact) => ({ name: fact.value.name, type: fact.value.type })),
        pk: keys.find((fact) => fact.table === name)?.value ?? [],
      })),
      preData: postgres.slice(entry.preData[0], entry.preData[1]),
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
  return {
    id: "state",
    version: OPENCLAW_STATE_SCHEMA_VERSION,
    minimumPostgresVersion: manifest.minimumPostgresVersion,
    ...schema(
      metadata,
      statePostgresRuntime.eagerSql,
      metadata.sqliteRanges
        .map(([start, end]) => OPENCLAW_STATE_SCHEMA_SQL.slice(start, end))
        .join("\n"),
    ),
    fragments: metadata.fragments.map((fragment) => {
      const runtime = statePostgresRuntime.fragments.find((entry) => entry.id === fragment.id)!;
      return Object.assign(schema(fragment, runtime.sql, sqliteFragments.get(fragment.id)!), {
        id: fragment.id,
        dependencies: runtime.dependencies,
      });
    }),
    inspectSqliteSource(db) {
      admitSqliteSchema(db);
      assertOpenClawStateDatabaseForMaintenance(db, { pathname: "shared-state port source" });
      const version = getAdmittedSqliteSchemaFacts(db)!.userVersion;
      if (version !== OPENCLAW_STATE_SCHEMA_VERSION) {
        throw new DatabasePortDataError(
          "Shared-state port requires the current schema; run openclaw doctor --fix with the matching version first.",
        );
      }
      return { version, migrationRequired: false, pendingColumns: {} };
    },
    async admit(file, input) {
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
        });
        if (selected !== anchor) {
          selected.close();
        }
      });
    },
  };
}

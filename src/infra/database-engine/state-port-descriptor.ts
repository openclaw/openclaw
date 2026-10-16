import {
  admitStatePostgres,
  inspectStateSqlite,
  stateEngineSchema,
} from "../../state/openclaw-state-db-engine.js";
import { assertOpenClawStateDatabaseForMaintenance } from "../../state/openclaw-state-db-maintenance.js";
import { statePostgresRuntime } from "../../state/postgres-schema.generated/runtime.js";
import metadata from "../../state/postgres-schema.generated/state-port.json" with { type: "json" };
import { openNodeSqliteDatabase } from "../node-sqlite.js";
import { admitSqliteSchema, getAdmittedSqliteSchemaFacts } from "../sqlite-schema-facts.js";
import { withEngineStoreAdmission } from "./admission-scope.js";
import { openEngineStore } from "./open.js";
import { DatabasePortDataError, type PortDescriptor } from "./port-descriptor.js";
import { expectedPostgresCatalog } from "./postgres-catalog.js";

export async function loadStatePortDescriptor(): Promise<PortDescriptor> {
  const schema = (entry: Omit<typeof metadata, "fragments">, postgres: string) => ({
    ...entry,
    preData: postgres.slice(entry.preData[0], entry.preData[1]),
    postData: postgres.slice(entry.postData[0], entry.postData[1]),
    expectedCatalog: expectedPostgresCatalog(entry),
  });
  return {
    ...schema(metadata, statePostgresRuntime.eagerSql),
    fragments: metadata.fragments.map((fragment) => ({
      ...schema(
        fragment,
        statePostgresRuntime.fragments.find((entry) => entry.id === fragment.id)!.sql,
      ),
      dependencies: fragment.dependencies,
    })),
    inspectSqliteSource(db) {
      admitSqliteSchema(db);
      assertOpenClawStateDatabaseForMaintenance(db, { pathname: "shared-state port source" });
      const version = getAdmittedSqliteSchemaFacts(db)!.userVersion;
      if (version !== metadata.version) {
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

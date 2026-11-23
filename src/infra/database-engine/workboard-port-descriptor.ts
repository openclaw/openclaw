import type { DatabaseSync } from "node:sqlite";
import type { WorkboardDatabasePortApi } from "@openclaw/workboard-contract";
import { loadBundledPluginPublicArtifactModuleSync } from "../../plugins/public-surface-loader.js";
import {
  historicalIndexOrderingPort,
  historicalPortVersion,
} from "./historical-index-ordering-port.js";
import { DatabasePortDataError, type PortDescriptor } from "./port-descriptor.js";
import { expectedPostgresCatalog } from "./postgres-catalog.js";
import type { DatabaseEngineInput } from "./types.js";
import metadata from "./workboard-port.generated.json" with { type: "json" };

export async function loadDescriptor(sourceVersion = metadata.version): Promise<PortDescriptor> {
  if (sourceVersion !== metadata.version && sourceVersion !== 3 && sourceVersion !== 4) {
    throw new DatabasePortDataError(
      `Missing workboard PostgreSQL backup descriptor for version ${sourceVersion}`,
    );
  }
  const api = loadBundledPluginPublicArtifactModuleSync<{
    workboardDatabasePortApi: WorkboardDatabasePortApi<DatabaseSync, DatabaseEngineInput>;
  }>({ dirName: "workboard", artifactBasename: "database-port-api.js" }).workboardDatabasePortApi;
  const { postgres } = api;
  const descriptor: PortDescriptor = {
    ...metadata,
    preData: postgres.slice(metadata.preData[0], metadata.preData[1]),
    postData: postgres.slice(metadata.postData[0], metadata.postData[1]),
    expectedCatalog: expectedPostgresCatalog(metadata),
    inspectSqliteSource(db) {
      try {
        return api.inspectWorkboardPortSource(db);
      } catch (error) {
        if (error instanceof api.WorkboardPortSchemaError) {
          throw new DatabasePortDataError(error.message);
        }
        throw error;
      }
    },
    migrateSqliteSource: (file) => api.admitWorkboardPort(file),
    admit: (file, input) => api.admitWorkboardPort(file, input),
  };
  if (sourceVersion === metadata.version) {
    return descriptor;
  }
  const historicalPostgres = postgres.replace('  "common_work_json" text COLLATE "C",\n', "");
  const commonWorkColumn = descriptor.expectedCatalog.find(
    (fact) =>
      fact.table === "workboard_cards" &&
      fact.kind === "column" &&
      typeof fact.value === "object" &&
      fact.value !== null &&
      "name" in fact.value &&
      fact.value.name === "common_work_json",
  );
  const commonWorkPosition =
    commonWorkColumn &&
    typeof commonWorkColumn.value === "object" &&
    commonWorkColumn.value !== null &&
    "position" in commonWorkColumn.value &&
    typeof commonWorkColumn.value.position === "number"
      ? commonWorkColumn.value.position
      : Number.POSITIVE_INFINITY;
  const historical = {
    ...descriptor,
    sqlite: descriptor.sqlite.replace("      common_work_json TEXT,\n", ""),
    preData: descriptor.preData.replace('  "common_work_json" text COLLATE "C",\n', ""),
    tables: descriptor.tables.map((table) =>
      table.name === "workboard_cards"
        ? {
            ...table,
            columns: table.columns.filter((column) => column.name !== "common_work_json"),
          }
        : table,
    ),
    expectedCatalog: descriptor.expectedCatalog
      .filter(
        (fact) =>
          !(
            fact.table === "workboard_cards" &&
            fact.kind === "column" &&
            typeof fact.value === "object" &&
            fact.value !== null &&
            "name" in fact.value &&
            fact.value.name === "common_work_json"
          ),
      )
      .flatMap((fact) => {
        if (
          fact.table !== "workboard_cards" ||
          fact.kind !== "column" ||
          typeof fact.value !== "object" ||
          fact.value === null ||
          !("position" in fact.value) ||
          typeof fact.value.position !== "number" ||
          fact.value.position <= commonWorkPosition
        ) {
          return [fact];
        }
        return [{ ...fact, value: { ...fact.value, position: fact.value.position - 1 } }];
      }),
  };
  if (sourceVersion === 4) {
    return historicalPortVersion(historical, sourceVersion, historicalPostgres);
  }
  return historicalIndexOrderingPort(historical, sourceVersion, historicalPostgres);
}

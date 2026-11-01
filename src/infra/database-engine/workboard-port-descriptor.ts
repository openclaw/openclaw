import fs from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { WorkboardDatabasePortApi } from "@openclaw/workboard-contract";
import { resolveBundledPluginsDir } from "../../plugins/bundled-dir.js";
import { loadBundledPluginPublicArtifactModuleSync } from "../../plugins/public-surface-loader.js";
import { historicalIndexOrderingPort } from "./historical-index-ordering-port.js";
import { DatabasePortDataError, type PortDescriptor } from "./port-descriptor.js";
import { expectedPostgresCatalog } from "./postgres-catalog.js";
import type { DatabaseEngineInput } from "./types.js";
import metadata from "./workboard-port.generated.json" with { type: "json" };

export async function loadDescriptor(sourceVersion = metadata.version): Promise<PortDescriptor> {
  if (sourceVersion !== metadata.version && sourceVersion !== 3) {
    throw new DatabasePortDataError(
      `Missing workboard PostgreSQL backup descriptor for version ${sourceVersion}`,
    );
  }
  const plugins = resolveBundledPluginsDir();
  if (!plugins) {
    throw new Error("Bundled workboard port descriptor is unavailable.");
  }
  const postgres = await fs.readFile(
    path.join(plugins, "workboard/src/workboard-schema.postgres.sql"),
    "utf8",
  );
  const descriptor: PortDescriptor = {
    ...metadata,
    preData: postgres.slice(metadata.preData[0], metadata.preData[1]),
    postData: postgres.slice(metadata.postData[0], metadata.postData[1]),
    expectedCatalog: expectedPostgresCatalog(metadata),
    inspectSqliteSource(db) {
      try {
        return api().inspectWorkboardPortSource(db);
      } catch (error) {
        if (error instanceof api().WorkboardPortSchemaError) {
          throw new DatabasePortDataError(error.message);
        }
        throw error;
      }
    },
    migrateSqliteSource: (file) => api().admitWorkboardPort(file),
    admit: (file, input) => api().admitWorkboardPort(file, input),
  };
  if (sourceVersion === metadata.version) {
    return descriptor;
  }
  return historicalIndexOrderingPort(descriptor, sourceVersion, postgres);
}

function api() {
  return loadBundledPluginPublicArtifactModuleSync<{
    workboardDatabasePortApi: WorkboardDatabasePortApi<DatabaseSync, DatabaseEngineInput>;
  }>({ dirName: "workboard", artifactBasename: "database-port-api.js" }).workboardDatabasePortApi;
}

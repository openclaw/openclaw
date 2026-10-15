import fs from "node:fs/promises";
import path from "node:path";
import type { logbookDatabasePortApi } from "../../../extensions/logbook/database-port-api.js";
import { resolveBundledPluginsDir } from "../../plugins/bundled-dir.js";
import { loadBundledPluginPublicArtifactModuleSync } from "../../plugins/public-surface-loader.js";
import metadata from "./logbook-port.generated.json" with { type: "json" };
import { DatabasePortDataError, type PortDescriptor } from "./port-descriptor.js";
import { expectedPostgresCatalog } from "./postgres-catalog.js";

export async function loadDescriptor(): Promise<PortDescriptor> {
  const plugins = resolveBundledPluginsDir();
  if (!plugins) {
    throw new Error("Bundled logbook port descriptor is unavailable.");
  }
  const postgres = await fs.readFile(
    path.join(plugins, "logbook/src/logbook-schema.postgres.sql"),
    "utf8",
  );
  return {
    ...metadata,
    preData: postgres.slice(metadata.preData[0], metadata.preData[1]),
    postData: postgres.slice(metadata.postData[0], metadata.postData[1]),
    expectedCatalog: expectedPostgresCatalog(metadata),
    inspectSqliteSource(db) {
      try {
        return api().inspectLogbookPortSource(db);
      } catch (error) {
        if (error instanceof api().LogbookPortSchemaError) {
          throw new DatabasePortDataError(error.message);
        }
        throw error;
      }
    },
    migrateSqliteSource: (file) => api().admitLogbookPort(file),
    admit: (file, input) => api().admitLogbookPort(file, input),
  };
}

function api() {
  return loadBundledPluginPublicArtifactModuleSync<{
    logbookDatabasePortApi: typeof logbookDatabasePortApi;
  }>({ dirName: "logbook", artifactBasename: "database-port-api.js" }).logbookDatabasePortApi;
}

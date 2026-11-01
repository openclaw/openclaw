import fs from "node:fs/promises";
import path from "node:path";
import { resolveBundledPluginsDir } from "../../plugins/bundled-dir.js";
import { loadBundledPluginPublicArtifactModuleSync } from "../../plugins/public-surface-loader.js";
import { historicalIndexOrderingPort } from "./historical-index-ordering-port.js";
import metadata from "./logbook-port.generated.json" with { type: "json" };
import { DatabasePortDataError, type PortDescriptor } from "./port-descriptor.js";
import { expectedPostgresCatalog } from "./postgres-catalog.js";

export async function loadLogbookPortDescriptor(
  sourceVersion = metadata.version,
): Promise<PortDescriptor> {
  if (sourceVersion !== metadata.version && sourceVersion !== 1 && sourceVersion !== 2) {
    throw new DatabasePortDataError(
      `Missing logbook PostgreSQL backup descriptor for version ${sourceVersion}`,
    );
  }
  const plugins = resolveBundledPluginsDir();
  if (!plugins) {
    throw new Error("Bundled logbook port descriptor is unavailable.");
  }
  const postgres = await fs.readFile(
    path.join(plugins, "logbook/src/logbook-schema.postgres.sql"),
    "utf8",
  );
  const descriptor: PortDescriptor = {
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
  if (sourceVersion === metadata.version) {
    return descriptor;
  }
  return historicalIndexOrderingPort(
    descriptor,
    sourceVersion,
    postgres,
    sourceVersion === 2 ? "schema-nullability" : "sqlite",
  );
}

function api() {
  return loadBundledPluginPublicArtifactModuleSync<{
    logbookDatabasePortApi: {
      LogbookPortSchemaError: new (message?: string) => Error;
      inspectLogbookPortSource: NonNullable<PortDescriptor["inspectSqliteSource"]>;
      admitLogbookPort: NonNullable<PortDescriptor["admit"]>;
    };
  }>({ dirName: "logbook", artifactBasename: "database-port-api.js" }).logbookDatabasePortApi;
}

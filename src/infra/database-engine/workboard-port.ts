import fs from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { WorkboardDatabasePortApi } from "@openclaw/workboard-contract";
import { resolveBundledPluginsDir } from "../../plugins/bundled-dir.js";
import { loadBundledPluginPublicArtifactModuleSync } from "../../plugins/public-surface-loader.js";
import type { DatabaseEngineInput } from "./config.js";
import type { DatabasePortProvider } from "./port-provider.js";
import { DatabasePortDataError, type PortDescriptor } from "./port.worker.js";
import { expectedPostgresCatalog } from "./postgres-catalog.js";
import metadata from "./workboard-port.generated.json" with { type: "json" };

async function loadDescriptor(): Promise<PortDescriptor> {
  const plugins = resolveBundledPluginsDir();
  if (!plugins) {
    throw new Error("Bundled workboard port descriptor is unavailable.");
  }
  const postgres = await fs.readFile(
    path.join(plugins, "workboard/src/workboard-schema.postgres.sql"),
    "utf8",
  );
  return {
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
}

function api() {
  return loadBundledPluginPublicArtifactModuleSync<{
    workboardDatabasePortApi: WorkboardDatabasePortApi<DatabaseSync, DatabaseEngineInput>;
  }>({ dirName: "workboard", artifactBasename: "database-port-api.js" }).workboardDatabasePortApi;
}

export const workboardPortProvider: DatabasePortProvider = {
  id: "workboard",
  loadDescriptor,
  matchesSqlite: (tables) => tables.has("workboard_schema_migrations"),
  resolveRoots(context) {
    return context.plugins.plugins
      .filter((plugin) => plugin.id === "workboard")
      .flatMap((plugin) =>
        (plugin.backupResources ?? [])
          .filter((resource) => resource.scope === "state" && resource.disposition === "include")
          .map((resource) => path.join(context.stateDir, resource.relativePath)),
      );
  },
};

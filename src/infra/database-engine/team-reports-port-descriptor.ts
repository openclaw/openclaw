import { loadBundledPluginPublicArtifactModuleFromCandidatesSync } from "../../plugins/public-surface-loader.js";
import { historicalIndexOrderingPort } from "./historical-index-ordering-port.js";
import {
  DatabasePortDataError,
  type DatabasePortProvider,
  type PortDescriptor,
} from "./port-descriptor.js";
import { expectedPostgresCatalog } from "./postgres-catalog.js";
import metadata from "./team-reports-port.generated.json" with { type: "json" };

export async function loadTeamReportsPortDescriptor(
  owner?: Parameters<DatabasePortProvider["loadDescriptor"]>[0],
  sourceVersion = metadata.version,
): Promise<PortDescriptor> {
  if (sourceVersion !== metadata.version && sourceVersion !== 1) {
    throw new DatabasePortDataError(
      `Missing team-reports PostgreSQL backup descriptor for version ${sourceVersion}`,
    );
  }
  const api = loadBundledPluginPublicArtifactModuleFromCandidatesSync<{
    teamReportsDatabasePortApi: {
      postgres: string;
      inspectSqliteSource: NonNullable<PortDescriptor["inspectSqliteSource"]>;
      admit: NonNullable<PortDescriptor["admit"]>;
    };
  }>({
    dirName: "team-reports",
    artifactCandidates: ["database-port-api.js"],
    owner,
  })?.teamReportsDatabasePortApi;
  if (!api) {
    throw new DatabasePortDataError(
      "Team Reports port API is unavailable; install the matching Team Reports plugin.",
    );
  }
  const descriptor: PortDescriptor = {
    ...metadata,
    preData: api.postgres.slice(metadata.preData[0], metadata.preData[1]),
    postData: api.postgres.slice(metadata.postData[0], metadata.postData[1]),
    expectedCatalog: expectedPostgresCatalog(metadata),
    inspectSqliteSource(db) {
      try {
        return api.inspectSqliteSource(db);
      } catch (error) {
        throw new DatabasePortDataError(error instanceof Error ? error.message : String(error));
      }
    },
    migrateSqliteSource: (file) => api.admit(file),
    admit: (file, input) => api.admit(file, input),
  };
  if (sourceVersion === metadata.version) {
    return descriptor;
  }
  return historicalIndexOrderingPort(descriptor, sourceVersion, api.postgres);
}

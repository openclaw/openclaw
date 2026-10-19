import { loadBundledPluginPublicArtifactModuleFromCandidatesSync } from "../../plugins/public-surface-loader.js";
import {
  DatabasePortDataError,
  type DatabasePortProvider,
  type PortDescriptor,
} from "./port-descriptor.js";
import { expectedPostgresCatalog } from "./postgres-catalog.js";
import metadata from "./team-reports-port.generated.json" with { type: "json" };

export async function loadTeamReportsPortDescriptor(
  owner?: Parameters<DatabasePortProvider["loadDescriptor"]>[0],
): Promise<PortDescriptor> {
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
  return {
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
}

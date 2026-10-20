import path from "node:path";
import type { DatabasePortProvider } from "./port-descriptor.js";

export const teamReportsPortProvider: DatabasePortProvider = {
  id: "team-reports",
  minimumPostgresVersion: 16,
  requiresPluginOwner: true,
  async loadDescriptor(owner) {
    const { loadTeamReportsPortDescriptor } = await import("./team-reports-port-descriptor.js");
    return loadTeamReportsPortDescriptor(owner);
  },
  matchesSqlite: (tables) => tables.has("team_reports_schema_migrations"),
  resolveRoots(context) {
    return context.plugins.plugins
      .filter((plugin) => plugin.id === "team-reports")
      .flatMap((plugin) =>
        (plugin.backupResources ?? [])
          .filter((resource) => resource.scope === "state" && resource.disposition === "include")
          .map((resource) => path.join(context.stateDir, resource.relativePath)),
      );
  },
};

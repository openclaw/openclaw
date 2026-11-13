import { resolvePluginPortRoots } from "./plugin-port-roots.js";
import type { DatabasePortProvider } from "./port-descriptor.js";

export const teamReportsPortProvider: DatabasePortProvider = {
  id: "team-reports",
  minimumPostgresVersion: 16,
  requiresPluginOwner: true,
  async loadDescriptor(owner, version) {
    const { loadTeamReportsPortDescriptor } = await import("./team-reports-port-descriptor.js");
    return loadTeamReportsPortDescriptor(owner, version);
  },
  matchesSqlite: (tables) => tables.has("team_reports_schema_migrations"),
  resolveRoots: (context) => resolvePluginPortRoots(context, "team-reports"),
};

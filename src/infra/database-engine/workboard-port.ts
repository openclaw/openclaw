import { resolvePluginPortRoots } from "./plugin-port-roots.js";
import type { DatabasePortProvider } from "./port-descriptor.js";

export const workboardPortProvider: DatabasePortProvider = {
  id: "workboard",
  minimumPostgresVersion: 16,
  async loadDescriptor() {
    const { loadDescriptor } = await import("./workboard-port-descriptor.js");
    return loadDescriptor();
  },
  matchesSqlite: (tables) => tables.has("workboard_schema_migrations"),
  resolveRoots: (context) => resolvePluginPortRoots(context, "workboard"),
};

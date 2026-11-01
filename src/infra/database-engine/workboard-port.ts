import { resolvePluginPortRoots } from "./plugin-port-roots.js";
import type { DatabasePortProvider } from "./port-descriptor.js";

export const workboardPortProvider: DatabasePortProvider = {
  id: "workboard",
  minimumPostgresVersion: 16,
  async loadDescriptor(_owner, version) {
    const { loadDescriptor } = await import("./workboard-port-descriptor.js");
    return loadDescriptor(version);
  },
  matchesSqlite: (tables) => tables.has("workboard_schema_migrations"),
  resolveRoots: (context) => resolvePluginPortRoots(context, "workboard"),
};

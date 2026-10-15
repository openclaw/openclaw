import path from "node:path";
import type { DatabasePortProvider } from "./port-descriptor.js";

export const workboardPortProvider: DatabasePortProvider = {
  id: "workboard",
  async loadDescriptor() {
    const { loadDescriptor } = await import("./workboard-port-descriptor.js");
    return loadDescriptor();
  },
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

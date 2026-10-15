import path from "node:path";
import type { DatabasePortProvider } from "./port-descriptor.js";

export const logbookPortProvider: DatabasePortProvider = {
  id: "logbook",
  async loadDescriptor() {
    const { loadDescriptor } = await import("./logbook-port-descriptor.js");
    return loadDescriptor();
  },
  matchesSqlite: (tables) =>
    ["batches", "frames", "observations", "cards", "standups"].every((table) => tables.has(table)),
  resolveRoots(context) {
    return context.plugins.plugins
      .filter((plugin) => plugin.id === "logbook")
      .flatMap((plugin) =>
        (plugin.backupResources ?? [])
          .filter(
            (resource) =>
              resource.scope === "state" &&
              resource.disposition === "include" &&
              resource.relativePath.endsWith(".sqlite"),
          )
          .map((resource) => path.join(context.stateDir, resource.relativePath)),
      );
  },
};

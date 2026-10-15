import path from "node:path";
import type { DatabasePortProvider } from "./port-descriptor.js";

export const logbookPortProvider: DatabasePortProvider = {
  id: "logbook",
  async loadDescriptor() {
    const { loadLogbookPortDescriptor } = await import("./logbook-port-descriptor.js");
    return loadLogbookPortDescriptor();
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

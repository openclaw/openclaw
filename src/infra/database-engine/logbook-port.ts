import { resolvePluginPortRoots } from "./plugin-port-roots.js";
import type { DatabasePortProvider } from "./port-descriptor.js";

export const logbookPortProvider: DatabasePortProvider = {
  id: "logbook",
  minimumPostgresVersion: 16,
  async loadDescriptor() {
    const { loadLogbookPortDescriptor } = await import("./logbook-port-descriptor.js");
    return loadLogbookPortDescriptor();
  },
  matchesSqlite: (tables) =>
    ["batches", "frames", "observations", "cards", "standups"].every((table) => tables.has(table)),
  resolveRoots: (context) => resolvePluginPortRoots(context, "logbook", true),
};

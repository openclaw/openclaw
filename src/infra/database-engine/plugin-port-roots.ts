import path from "node:path";
import type { DatabasePortProvider } from "./port-descriptor.js";

export function resolvePluginPortRoots(
  context: Parameters<DatabasePortProvider["resolveRoots"]>[0],
  pluginId: string,
  sqliteOnly = false,
): string[] {
  return context.plugins.plugins
    .filter((plugin) => plugin.id === pluginId)
    .flatMap((plugin) =>
      (plugin.backupResources ?? [])
        .filter(
          (resource) =>
            resource.scope === "state" &&
            resource.disposition === "include" &&
            (!sqliteOnly || resource.relativePath.endsWith(".sqlite")),
        )
        .map((resource) => path.join(context.stateDir, resource.relativePath)),
    );
}

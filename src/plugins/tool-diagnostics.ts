import type { PluginRegistry, PluginToolRegistration } from "./registry-types.js";

export function recordToolDiagnostic(
  registry: PluginRegistry,
  diagnostic: PluginRegistry["diagnostics"][number],
): boolean {
  const exists = registry.diagnostics.some(
    (entry) =>
      entry.level === diagnostic.level &&
      entry.pluginId === diagnostic.pluginId &&
      entry.source === diagnostic.source &&
      entry.message === diagnostic.message,
  );
  if (!exists) {
    registry.diagnostics.push(diagnostic);
  }
  return !exists;
}

export function createPluginToolDiagnosticReporter(
  registry: PluginRegistry,
  logger: { error: (message: string) => void; warn: (message: string) => void },
) {
  return {
    error(entry: PluginToolRegistration, message: string) {
      logger.error(message);
      recordToolDiagnostic(registry, {
        level: "error",
        pluginId: entry.pluginId,
        source: entry.source,
        message,
      });
    },
    warnOnce(entry: PluginToolRegistration, message: string) {
      if (
        recordToolDiagnostic(registry, {
          level: "warn",
          pluginId: entry.pluginId,
          source: entry.source,
          message,
        })
      ) {
        logger.warn(message);
      }
    },
  };
}

/** Match both shipped warning forms without reading retired migration reports. */
export async function readResolvedDeferredPluginMigrationWarnings(
  messages: readonly (string | undefined)[],
): Promise<ReadonlyMap<string, number>> {
  const pluginWarnings = new Map<string, string>();
  for (const message of messages) {
    const pluginId =
      message &&
      /^Plugin "([^"]+)" (?:state migration is pending|data\/settings upgrade is unfinished):/u.exec(
        message,
      )?.[1];
    if (message && pluginId) {
      pluginWarnings.set(message, pluginId);
    }
  }
  if (!pluginWarnings.size) {
    return new Map();
  }
  const { readDeferredPluginMigrationCompletionsAsync } =
    await import("./deferred-plugin-migrations.js");
  const completions = new Map(
    (await readDeferredPluginMigrationCompletionsAsync()).map(({ pluginId, completedAtMs }) => [
      pluginId,
      completedAtMs,
    ]),
  );
  const resolved = new Map<string, number>();
  for (const [message, pluginId] of pluginWarnings) {
    const completedAtMs = completions.get(pluginId);
    if (completedAtMs !== undefined) {
      resolved.set(message, completedAtMs);
    }
  }
  return resolved;
}

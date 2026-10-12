/** Match both shipped warning forms without reading retired migration reports. */
export async function readResolvedDeferredPluginMigrationWarnings(
  messages: readonly (string | undefined)[],
): Promise<ReadonlySet<string>> {
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
    return new Set();
  }
  const { readDeferredPluginMigrationsAsync } = await import("./deferred-plugin-migrations.js");
  const pending = new Set(
    (await readDeferredPluginMigrationsAsync()).map(({ pluginId }) => pluginId),
  );
  return new Set(
    [...pluginWarnings]
      .filter(([, pluginId]) => !pending.has(pluginId))
      .map(([message]) => message),
  );
}

/**
 * Select deferred plugin migration warnings that no longer describe current state:
 * the plugin's obligation left the pending ledger, or a later warning for the same
 * plugin superseded it, or the caller reports that plugin's final state itself.
 * Matches both shipped warning forms without reading retired migration reports.
 * Messages are ordered oldest first.
 */
export async function readRetiredDeferredPluginMigrationWarnings(
  messages: readonly (string | undefined)[],
  finallyReportedPluginIds: ReadonlySet<string> = new Set(),
): Promise<ReadonlySet<string>> {
  const pluginWarnings = new Map<string, string>();
  const latestByPlugin = new Map<string, string>();
  for (const message of messages) {
    const pluginId =
      message &&
      /^Plugin "([^"]+)" (?:state migration is pending|data\/settings upgrade is unfinished):/u.exec(
        message,
      )?.[1];
    if (message && pluginId) {
      pluginWarnings.set(message, pluginId);
      latestByPlugin.set(pluginId, message);
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
      .filter(
        ([message, pluginId]) =>
          !pending.has(pluginId) ||
          latestByPlugin.get(pluginId) !== message ||
          finallyReportedPluginIds.has(pluginId),
      )
      .map(([message]) => message),
  );
}

/**
 * Drops warnings a later repair in the same pass settled or superseded, such as
 * post-session plugin migrations finishing after config preflight reported them
 * pending. The ledger is authoritative; an unreadable ledger keeps every warning.
 */
export async function retainCurrentDeferredPluginMigrationWarnings(
  warnings: readonly string[],
): Promise<string[]> {
  const retired = await readRetiredDeferredPluginMigrationWarnings(warnings).catch(
    () => new Set<string>(),
  );
  return warnings.filter((warning) => !retired.has(warning));
}

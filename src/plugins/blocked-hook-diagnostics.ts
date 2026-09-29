import type { PluginRegistry } from "./registry-types.js";

/** Project host-owned facts without local source paths or shadowed plugin records. */
export function projectBlockedHookDiagnostics(registry: PluginRegistry | null) {
  const records = new Map(registry?.plugins.toReversed().map((record) => [record.id, record]));
  return (registry?.blockedHooks ?? []).flatMap(({ source, ...entry }) => {
    const record = records.get(entry.pluginId);
    return record?.source === source ? [{ ...entry, pluginName: record.name }] : [];
  });
}

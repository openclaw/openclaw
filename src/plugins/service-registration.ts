import type { PluginRecord, PluginRegistry, PluginServiceRegistration } from "./registry-types.js";

/** Attach the service and its owner together for reload, replacement, and shutdown. */
export function addPluginServiceRegistration(
  registry: PluginRegistry,
  record: PluginRecord,
  id: string,
  service: PluginServiceRegistration["service"],
): void {
  record.services.push(id);
  registry.services.push({
    id,
    pluginId: record.id,
    pluginName: record.name,
    service,
    source: record.source,
    origin: record.origin,
    trustedOfficialInstall: record.trustedOfficialInstall,
    rootDir: record.rootDir,
  });
}

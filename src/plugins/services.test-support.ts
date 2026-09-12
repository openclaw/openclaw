import type { PluginOrigin } from "./plugin-origin.types.js";
import { createEmptyPluginRegistry } from "./registry.js";
import type { startPluginServices } from "./services.js";
import type { OpenClawPluginService } from "./types.js";

export function createRegistry(
  services: OpenClawPluginService[],
  pluginId = "plugin:test",
  origin: PluginOrigin = "workspace",
) {
  const registry = createEmptyPluginRegistry();
  registry.services = services.map((service) => ({
    pluginId,
    service,
    source: "test",
    origin,
    rootDir: "/plugins/test-plugin",
  })) as typeof registry.services;
  return registry;
}

export const createServiceConfig = () =>
  ({}) as Parameters<typeof startPluginServices>[0]["config"];

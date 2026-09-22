import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginOrigin } from "./plugin-origin.types.js";
import type { PluginServiceRegistration } from "./registry-types.js";
import { createEmptyPluginRegistry } from "./registry.js";
import type { OpenClawPluginService } from "./types.js";

export function createServiceRegistration(
  service: OpenClawPluginService,
  owner: Partial<Omit<PluginServiceRegistration, "id" | "service">> = {},
): PluginServiceRegistration {
  return {
    pluginId: "plugin:test",
    source: "test",
    origin: "workspace",
    ...owner,
    id: service.id.trim(),
    service,
  };
}

export function createRegistry(
  services: OpenClawPluginService[],
  pluginId = "plugin:test",
  origin: PluginOrigin = "workspace",
) {
  const registry = createEmptyPluginRegistry();
  registry.services = services.map((service) =>
    createServiceRegistration(service, {
      pluginId,
      origin,
      rootDir: "/plugins/test-plugin",
    }),
  );
  return registry;
}

export const createServiceConfig = (): OpenClawConfig => ({});

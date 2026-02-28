import { createEmptyPluginRegistry, type PluginRegistry } from "../../../plugins/registry.js";

export const createTestRegistry = (overrides: Partial<PluginRegistry> = {}): PluginRegistry => {
  const merged = { ...createEmptyPluginRegistry(), ...overrides };
  return {
    ...merged,
    gatewayHandlers: merged.gatewayHandlers ?? {},
    httpHandlers: merged.httpHandlers ?? [],
    httpRoutes: merged.httpRoutes ?? [],
  };
};

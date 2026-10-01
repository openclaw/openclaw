// Gateway server test utilities build plugin-registry fixtures for nested server suites.
import type { IncomingMessage, ServerResponse } from "node:http";
import { createEmptyPluginRegistry } from "../../../plugins/registry-empty.js";
import type { PluginRegistry } from "../../../plugins/registry.js";

/**
 * Shared plugin-registry fixtures for gateway server tests.
 */
export const createGatewayTestRegistry = (
  overrides: Partial<PluginRegistry> = {},
): PluginRegistry => {
  const registry = createEmptyPluginRegistry();
  for (const key of Object.keys(overrides) as Array<keyof PluginRegistry>) {
    const value = overrides[key];
    if (value !== undefined) {
      Object.assign(registry, { [key]: value });
    }
  }
  return registry;
};

export function createRoute(params: {
  path: string;
  auth: "gateway" | "plugin";
  match?: "exact" | "prefix";
  gatewayRuntimeScopeSurface?: "write-default" | "trusted-operator";
  gatewayMethodDispatchAllowed?: boolean;
  handler?: (req: IncomingMessage, res: ServerResponse) => boolean | Promise<boolean>;
}) {
  return {
    pluginId: "route",
    path: params.path,
    auth: params.auth,
    gatewayRuntimeScopeSurface: params.gatewayRuntimeScopeSurface,
    gatewayMethodDispatchAllowed: params.gatewayMethodDispatchAllowed,
    match: params.match ?? "exact",
    handler: params.handler ?? (() => true),
    source: "route",
  };
}

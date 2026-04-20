import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { GatewayRequestHandler } from "../../gateway/server-methods/types.js";
import { loadOpenClawPlugins } from "../loader.js";
import type { PluginRegistry } from "../registry.js";
import { resolveScopedRoutePluginIds } from "../route-plugin-ids.js";
import { buildPluginRuntimeLoadOptions, resolvePluginRuntimeLoadContext } from "./load-context.js";

export const GATEWAY_PLUGIN_HTTP_ROUTE_ID = "gateway-plugin-http";

export function loadScopedGatewayPluginHttpRouteRegistry(options?: {
  config?: OpenClawConfig;
  activationSourceConfig?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  workspaceDir?: string;
  coreGatewayHandlers?: Record<string, GatewayRequestHandler>;
  routeIds?: readonly string[];
}): PluginRegistry | undefined {
  const context = resolvePluginRuntimeLoadContext(options);
  const routePluginIds = resolveScopedRoutePluginIds({
    config: context.config,
    activationSourceConfig: context.activationSourceConfig,
    routeIds: options?.routeIds ?? [GATEWAY_PLUGIN_HTTP_ROUTE_ID],
    workspaceDir: context.workspaceDir,
    env: context.env,
    cache: true,
  });
  if (routePluginIds.length === 0) {
    return undefined;
  }
  return loadOpenClawPlugins(
    buildPluginRuntimeLoadOptions(context, {
      throwOnLoadError: true,
      onlyPluginIds: routePluginIds,
      coreGatewayHandlers: options?.coreGatewayHandlers,
      runtimeOptions: {
        allowGatewaySubagentBinding: true,
      },
    }),
  );
}

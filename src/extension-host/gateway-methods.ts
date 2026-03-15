import type { GatewayRequestHandlers } from "../gateway/server-methods/types.js";
import type { PluginRegistry } from "../plugins/registry.js";
import type { PluginDiagnostic } from "../plugins/types.js";

export function resolveExtensionHostGatewayMethods(params: {
  registry: PluginRegistry;
  baseMethods: string[];
}): string[] {
  const pluginMethods = Object.keys(params.registry.gatewayHandlers);
  return Array.from(new Set([...params.baseMethods, ...pluginMethods]));
}

export function createExtensionHostGatewayExtraHandlers(params: {
  registry: PluginRegistry;
  extraHandlers?: GatewayRequestHandlers;
}): GatewayRequestHandlers {
  return {
    ...params.registry.gatewayHandlers,
    ...params.extraHandlers,
  };
}

export function logExtensionHostPluginDiagnostics(params: {
  diagnostics: PluginDiagnostic[];
  log: {
    info: (msg: string) => void;
    error: (msg: string) => void;
  };
}): void {
  for (const diag of params.diagnostics) {
    const details = [
      diag.pluginId ? `plugin=${diag.pluginId}` : null,
      diag.source ? `source=${diag.source}` : null,
    ]
      .filter((entry): entry is string => Boolean(entry))
      .join(", ");
    const message = details
      ? `[plugins] ${diag.message} (${details})`
      : `[plugins] ${diag.message}`;
    if (diag.level === "error") {
      params.log.error(message);
      continue;
    }
    params.log.info(message);
  }
}

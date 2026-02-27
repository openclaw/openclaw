import type { loadConfig } from "../config/config.js";
import { loadOpenClawPlugins } from "../plugins/loader.js";
import { createEmptyPluginRegistry } from "../plugins/registry.js";
import type { GatewayRequestHandler } from "./server-methods/types.js";

export function loadGatewayPlugins(params: {
  cfg: ReturnType<typeof loadConfig>;
  workspaceDir: string;
  log: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
    debug: (msg: string) => void;
  };
  coreGatewayHandlers: Record<string, GatewayRequestHandler>;
  baseMethods: string[];
}) {
  let pluginRegistry: ReturnType<typeof loadOpenClawPlugins>;
  try {
    pluginRegistry = loadOpenClawPlugins({
      config: params.cfg,
      workspaceDir: params.workspaceDir,
      logger: {
        info: (msg) => params.log.info(msg),
        warn: (msg) => params.log.warn(msg),
        error: (msg) => params.log.error(msg),
        debug: (msg) => params.log.debug(msg),
      },
      coreGatewayHandlers: params.coreGatewayHandlers,
    });
  } catch (err) {
    // Surface the root cause clearly instead of letting an opaque crash
    // propagate and cause the gateway to restart in a loop.
    const errorText = String(err);
    params.log.error(
      `[plugins] Plugin loading failed: ${errorText}. Check plugins.entries in openclaw.json for stale or invalid entries, then run "openclaw doctor" to repair.`,
    );
    // Return an empty registry so the gateway can still start (without plugins)
    // rather than crash-looping.
    return { pluginRegistry: createEmptyPluginRegistry(), gatewayMethods: [...params.baseMethods] };
  }
  const pluginMethods = Object.keys(pluginRegistry.gatewayHandlers);
  const gatewayMethods = Array.from(new Set([...params.baseMethods, ...pluginMethods]));
  if (pluginRegistry.diagnostics.length > 0) {
    for (const diag of pluginRegistry.diagnostics) {
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
      } else {
        params.log.info(message);
      }
    }
  }
  return { pluginRegistry, gatewayMethods };
}

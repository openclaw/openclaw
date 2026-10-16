/**
 * Builds the operator-facing effective inventory for bundle MCP tools. Runtime
 * schema policy quarantines incompatible tools and emits notices instead of
 * silently hiding them.
 */
import { getPluginToolMeta } from "../plugins/tool-metadata.js";
import type { McpToolCatalog } from "./agent-bundle-mcp-types.js";
import {
  buildEffectiveToolInventory,
  type RuntimeCompatibleToolInventoryParams,
} from "./tools-effective-inventory-shared.js";
import type { EffectiveToolInventoryNotice } from "./tools-effective-inventory.types.js";

const BUNDLE_MCP_PLUGIN_ID = "bundle-mcp";

export function buildMcpCatalogNotices(catalog: McpToolCatalog): EffectiveToolInventoryNotice[] {
  return (catalog.diagnostics ?? []).map((diagnostic) => ({
    id: `mcp-server-diagnostic:${diagnostic.serverName}`,
    severity: "warning",
    message: `MCP server "${diagnostic.serverName}": ${diagnostic.message}`,
    servers: [diagnostic.serverName],
  }));
}

/** Builds the runtime-compatible MCP tool inventory and quarantine notices. */
export function buildRuntimeCompatibleMcpToolInventory(
  params: RuntimeCompatibleToolInventoryParams,
) {
  return buildEffectiveToolInventory(params, {
    allowProviderRuntimePluginLoad: false,
    rawDescriptionFallback: "summary",
    diagnosticOwner: () => ` from plugin "${BUNDLE_MCP_PLUGIN_ID}"`,
    createToolProjection: () => (tool) => {
      const mcp = getPluginToolMeta(tool)?.mcp;
      return {
        source: "mcp",
        pluginId: BUNDLE_MCP_PLUGIN_ID,
        ...(mcp
          ? {
              mcpServer: mcp.serverName,
              mcpToolName: mcp.toolName,
              ...(mcp.deniedBySession ? { deniedBySession: true } : {}),
            }
          : {}),
      };
    },
  });
}

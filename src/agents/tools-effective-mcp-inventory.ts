/**
 * Builds the operator-facing effective inventory for bundle MCP tools. Runtime
 * schema policy quarantines incompatible tools and emits notices instead of
 * silently hiding them.
 */
import { getPluginToolMeta } from "../plugins/tool-metadata.js";
import type { McpToolCatalog } from "./agent-bundle-mcp-types.js";
import type { RuntimeToolSchemaDiagnostic } from "./tool-schema-projection.js";
import { normalizeToolInventorySchemas } from "./tools-effective-inventory-build.js";
import {
  disambiguateEffectiveToolLabels,
  resolveEffectiveToolLabel,
  resolveEffectiveToolRawDescription,
  summarizeEffectiveToolDescription,
} from "./tools-effective-inventory-shared.js";
import type {
  EffectiveToolInventoryEntry,
  EffectiveToolInventoryNotice,
} from "./tools-effective-inventory.types.js";
import type { AnyAgentTool } from "./tools/common.js";

const BUNDLE_MCP_PLUGIN_ID = "bundle-mcp";

export function buildMcpCatalogNotices(catalog: McpToolCatalog): EffectiveToolInventoryNotice[] {
  return (catalog.diagnostics ?? []).map((diagnostic) => ({
    id: `mcp-server-diagnostic:${diagnostic.serverName}`,
    severity: "warning",
    message: `MCP server "${diagnostic.serverName}": ${diagnostic.message}`,
    servers: [diagnostic.serverName],
  }));
}

// Runtime schema diagnostics become operator-facing notices on the effective
// inventory screen instead of silently hiding quarantined MCP tools.
function buildMcpUnsupportedToolSchemaNotice(
  diagnostic: RuntimeToolSchemaDiagnostic,
): EffectiveToolInventoryNotice {
  return {
    id: `unsupported-tool-schema:${diagnostic.toolName}`,
    severity: "warning",
    message: `Tool "${diagnostic.toolName}" from plugin "${BUNDLE_MCP_PLUGIN_ID}" has an unsupported runtime input schema (${diagnostic.violations.join(", ")}) and was quarantined before model projection. Fix or disable the owner, or remove the tool from active allowlists.`,
  };
}

function buildMcpToolInventoryEntries(
  tools: readonly AnyAgentTool[],
): EffectiveToolInventoryEntry[] {
  return disambiguateEffectiveToolLabels(
    tools
      .map((tool) => {
        const mcp = getPluginToolMeta(tool)?.mcp;
        return {
          id: tool.name,
          label: resolveEffectiveToolLabel(tool),
          description: summarizeEffectiveToolDescription(tool),
          rawDescription:
            resolveEffectiveToolRawDescription(tool) || summarizeEffectiveToolDescription(tool),
          source: "mcp",
          pluginId: BUNDLE_MCP_PLUGIN_ID,
          ...(mcp
            ? {
                mcpServer: mcp.serverName,
                mcpToolName: mcp.toolName,
                ...(mcp.deniedBySession ? { deniedBySession: true } : {}),
              }
            : {}),
        } satisfies EffectiveToolInventoryEntry;
      })
      .toSorted((a, b) => a.label.localeCompare(b.label)),
    (entry) => entry.pluginId ?? entry.id,
  );
}

/** Builds the runtime-compatible MCP tool inventory and quarantine notices. */
export function buildRuntimeCompatibleMcpToolInventory(
  params: Parameters<typeof normalizeToolInventorySchemas>[0],
): {
  entries: EffectiveToolInventoryEntry[];
  notices: EffectiveToolInventoryNotice[];
} {
  const projection = normalizeToolInventorySchemas(params, false);
  return {
    entries: buildMcpToolInventoryEntries(projection.tools),
    notices: projection.diagnostics.map(buildMcpUnsupportedToolSchemaNotice),
  };
}

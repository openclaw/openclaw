/**
 * Builds the operator-facing effective inventory for the current tool surface:
 * runtime-compatible tools plus warnings for tools quarantined by schema
 * policy, with plugin/channel ownership preserved.
 */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { getActivePluginRegistry } from "../plugins/runtime.js";
import { buildPluginToolMetadataKey, getPluginToolMeta } from "../plugins/tool-metadata.js";
import { getChannelAgentToolMeta } from "./channel-tools.js";
import type { RuntimeToolSchemaDiagnostic } from "./tool-schema-projection.js";
import {
  buildEffectiveToolInventory,
  type RuntimeCompatibleToolInventoryParams,
} from "./tools-effective-inventory-shared.js";
import type { EffectiveToolInventoryEntry } from "./tools-effective-inventory.types.js";
import type { AnyAgentTool } from "./tools/common.js";

// Tool metadata may be attached to the normalized tool or the raw fallback
// before schema projection. Check both so owner attribution survives cloning.
function resolveEffectiveToolSource(
  tool: AnyAgentTool,
  fallbackTool?: AnyAgentTool,
): Pick<EffectiveToolInventoryEntry, "source" | "pluginId" | "channelId"> {
  const pluginMeta =
    getPluginToolMeta(tool) ?? (fallbackTool ? getPluginToolMeta(fallbackTool) : undefined);
  if (pluginMeta) {
    return {
      source: pluginMeta.mcp || pluginMeta.pluginId === "bundle-mcp" ? "mcp" : "plugin",
      pluginId: pluginMeta.pluginId,
    };
  }
  const channelMeta =
    getChannelAgentToolMeta(tool as never) ??
    (fallbackTool ? getChannelAgentToolMeta(fallbackTool as never) : undefined);
  if (channelMeta) {
    return { source: "channel", channelId: channelMeta.channelId };
  }
  return { source: "core" };
}

function readMatchingTool(
  tools: readonly AnyAgentTool[],
  diagnostic: RuntimeToolSchemaDiagnostic,
): AnyAgentTool | undefined {
  try {
    const tool = tools[diagnostic.toolIndex];
    return tool?.name === diagnostic.toolName ? tool : undefined;
  } catch {
    return undefined;
  }
}

// Raw tool arrays can contain getters/proxies from plugin boundaries. Read
// defensively; projection diagnostics handle the exact unreadable entry later.
export function buildReadableToolsByName(
  tools: readonly AnyAgentTool[],
): ReadonlyMap<string, AnyAgentTool> {
  const toolsByName = new Map<string, AnyAgentTool>();
  let toolCount: number;
  try {
    toolCount = tools.length;
  } catch {
    return toolsByName;
  }
  for (let index = 0; index < toolCount; index += 1) {
    try {
      const tool = tools.at(index);
      if (tool) {
        toolsByName.set(tool.name, tool);
      }
    } catch {
      // Unreadable entries are reported by the schema projection diagnostics.
    }
  }
  return toolsByName;
}

export function buildRuntimeCompatibleToolInventory(params: RuntimeCompatibleToolInventoryParams) {
  const rawToolsByName = buildReadableToolsByName(params.tools);
  return buildEffectiveToolInventory(params, {
    createToolProjection: () => {
      // Provider normalization can publish registry metadata; read it afterward,
      // keyed by ownership so one plugin cannot relabel another plugin's tool.
      const pluginToolMetadata = new Map(
        (getActivePluginRegistry()?.toolMetadata ?? []).map((entry) => [
          buildPluginToolMetadataKey(entry.pluginId, entry.metadata.toolName),
          entry.metadata,
        ]),
      );
      return (tool) => {
        const source = resolveEffectiveToolSource(tool, rawToolsByName.get(tool.name));
        const metadata = source.pluginId
          ? pluginToolMetadata.get(buildPluginToolMetadataKey(source.pluginId, tool.name))
          : undefined;
        const label = normalizeOptionalString(metadata?.displayName);
        const description = normalizeOptionalString(metadata?.description);
        return {
          ...source,
          ...(label ? { label } : {}),
          ...(description ? { description, rawDescription: description } : {}),
          ...(metadata?.risk ? { risk: metadata.risk } : {}),
          ...(metadata?.tags ? { tags: metadata.tags } : {}),
        };
      };
    },
    diagnosticOwner: (diagnostic, tools) => {
      const fallbackTool = rawToolsByName.get(diagnostic.toolName);
      const tool = readMatchingTool(tools, diagnostic) ?? fallbackTool;
      const source = tool ? resolveEffectiveToolSource(tool, fallbackTool) : undefined;
      return source?.source === "plugin" && source.pluginId
        ? ` from plugin "${source.pluginId}"`
        : source?.source === "channel" && source.channelId
          ? ` from channel "${source.channelId}"`
          : "";
    },
  });
}

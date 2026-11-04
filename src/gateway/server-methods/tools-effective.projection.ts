import { listCoreToolSections } from "../../agents/tool-catalog.js";
import { CODEX_GITHUB_PREVIEW_UNAVAILABLE_NOTICE } from "../../agents/tools-effective-inventory-shared.js";
import type { EffectiveToolInventoryResult } from "../../agents/tools-effective-inventory.types.js";

// Static presentation only: the effective inventory still owns tool selection.
const coreToolDescriptions = new Map(
  listCoreToolSections({ swarmEnabled: true, personalInstructionsEnabled: true }).flatMap(
    (section) => section.tools.map((tool) => [tool.id, tool.description] as const),
  ),
);

export function projectSessionToolPreview(
  inventory: EffectiveToolInventoryResult,
): EffectiveToolInventoryResult {
  return {
    agentId: inventory.agentId,
    profile: inventory.profile,
    // Rebuild this fixed core notice; never copy runtime diagnostic text or details.
    ...(inventory.notices?.some(
      (notice) => notice.id === CODEX_GITHUB_PREVIEW_UNAVAILABLE_NOTICE.id,
    )
      ? { notices: [CODEX_GITHUB_PREVIEW_UNAVAILABLE_NOTICE] }
      : {}),
    groups: inventory.groups.map((group) => ({
      id: group.id,
      label: group.label,
      source: group.source,
      tools: group.tools.map((tool) => {
        // Runtime descriptions and notices can contain MCP launch details or host paths.
        const description =
          tool.source !== "core"
            ? ""
            : tool.id === "github_publish"
              ? tool.rawDescription // Its owner renders only the policy-filtered action names.
              : (coreToolDescriptions.get(tool.id) ?? "");
        return {
          id: tool.id,
          label: tool.id,
          source: tool.source,
          description,
          rawDescription: description,
          ...(tool.pluginId ? { pluginId: tool.pluginId } : {}),
          ...(tool.channelId ? { channelId: tool.channelId } : {}),
          ...(tool.source === "mcp"
            ? { mcpServer: tool.mcpServer, mcpToolName: tool.mcpToolName }
            : {}),
          ...(tool.deniedBySession ? { deniedBySession: true as const } : {}),
        };
      }),
    })),
  };
}

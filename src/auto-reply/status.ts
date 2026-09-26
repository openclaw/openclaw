/** Auto-reply status/help message builders for commands, status, and tool inventory output. */
import { describeToolForVerbose } from "../agents/tool-description-summary.js";
import { normalizeToolPolicyName } from "../agents/tool-policy-shared.js";
import type {
  EffectiveToolInventoryEntry,
  EffectiveToolInventoryResult,
} from "../agents/tools-effective-inventory.types.js";

export {
  buildCommandsMessage,
  buildCommandsMessagePaginated,
  buildHelpMessage,
} from "./command-status-builders.js";
export { formatContextUsageShort } from "../status/status-message.js";
export { formatTokenCount } from "../utils/token-format.js";

function formatCompactToolEntry(tool: EffectiveToolInventoryEntry): string {
  const id = normalizeToolPolicyName(tool.id);
  const owner =
    tool.source === "plugin"
      ? tool.pluginId
      : tool.source === "channel"
        ? tool.channelId
        : undefined;
  return owner ? `${id} (${owner})` : id;
}

/** Formats the effective tool inventory shown by /tools. */
export function buildToolsMessage(
  result: EffectiveToolInventoryResult,
  options?: { verbose?: boolean },
): string {
  const groups = result.groups.filter((group) => group.tools.length > 0);

  if (groups.length === 0) {
    const lines = [
      "No tools are available for this agent right now.",
      "",
      `Profile: ${result.profile}`,
    ];
    return lines.join("\n");
  }

  const verbose = options?.verbose === true;
  const lines = verbose
    ? ["Available tools", "", `Profile: ${result.profile}`, "What this agent can use right now:"]
    : ["Available tools", "", `Profile: ${result.profile}`];

  for (const group of groups) {
    const tools = group.tools.toSorted((a, b) => a.label.localeCompare(b.label));
    lines.push("", group.label);
    if (verbose) {
      for (const tool of tools) {
        const description = describeToolForVerbose({
          rawDescription: tool.rawDescription || tool.description || "Tool",
          fallback: tool.description || "Tool",
        });
        lines.push(`  ${tool.label} - ${description}`);
      }
      continue;
    }
    lines.push(`  ${tools.map(formatCompactToolEntry).join(", ")}`);
  }

  if (verbose) {
    lines.push("", "Tool availability depends on this agent's configuration.");
  } else {
    lines.push("", "Use /tools verbose for descriptions.");
  }
  if (result.notices?.length) {
    lines.push("", "Notes");
    for (const notice of result.notices) {
      lines.push(`  ${notice.message}`);
    }
  }
  return lines.join("\n");
}

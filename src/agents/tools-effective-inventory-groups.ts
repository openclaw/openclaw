/**
 * Effective tool inventory grouping.
 *
 * Tool inventory reports use this to present effective tools in stable source
 * groups while preserving each source's original tool order.
 */
import type {
  EffectiveToolInventoryEntry,
  EffectiveToolInventoryGroup,
  EffectiveToolSource,
} from "./tools-effective-inventory.types.js";

/** Groups effective tool inventory entries by source in UI/report order. */
export function buildEffectiveToolInventoryGroups(
  entries: readonly EffectiveToolInventoryEntry[],
): EffectiveToolInventoryGroup[] {
  const groupsBySource = new Map<EffectiveToolSource, EffectiveToolInventoryEntry[]>();
  for (const entry of entries) {
    const tools = groupsBySource.get(entry.source) ?? [];
    tools.push(entry);
    groupsBySource.set(entry.source, tools);
  }

  return (
    [
      ["core", "Built-in tools"],
      ["plugin", "Connected tools"],
      ["channel", "Channel tools"],
      ["mcp", "MCP server tools"],
    ] as const
  ).flatMap(([source, label]) => {
    const tools = groupsBySource.get(source);
    return tools ? [{ id: source, label, source, tools }] : [];
  });
}

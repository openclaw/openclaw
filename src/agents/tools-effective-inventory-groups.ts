/**
 * Effective tool inventory grouping.
 *
 * Tool inventory reports use this to present effective tools in stable source
 * groups while preserving each source's original tool order.
 */
import { groupPluginRecords as groupRecords } from "../plugins/record-groups.js";
import type {
  EffectiveToolInventoryEntry,
  EffectiveToolInventoryGroup,
} from "./tools-effective-inventory.types.js";

/** Groups effective tool inventory entries by source in UI/report order. */
export function buildEffectiveToolInventoryGroups(
  entries: readonly EffectiveToolInventoryEntry[],
): EffectiveToolInventoryGroup[] {
  const groupsBySource = groupRecords(entries, (entry) => entry.source);

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

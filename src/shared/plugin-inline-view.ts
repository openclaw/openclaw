import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { PluginJsonValue } from "../plugins/host-hook-json.js";

export const PLUGIN_INLINE_VIEW_MAX_BYTES = 16 * 1024;

export type PluginInlineViewDescriptor = {
  pluginId: string;
  viewId: string;
  payload: PluginJsonValue;
};
export type PluginInlineViewBlock = {
  type: "plugin_view";
  pluginId: string;
  viewId: string;
  toolCallId: string;
  toolName: string;
  summary: string;
  label?: string;
  status: "ok" | "plugin-missing" | "view-missing" | "invalid-payload";
  payload?: PluginJsonValue;
};

/** Only the structured host projection is display input; never parse text or guest JSON. */
export function readPluginInlineViewBlock(value: unknown): PluginInlineViewBlock | undefined {
  const block = asOptionalRecord(value);
  if (
    block?.type !== "plugin_view" ||
    !["pluginId", "viewId", "toolCallId", "toolName", "summary"].every(
      (key) => typeof block[key] === "string" && block[key].trim().length > 0,
    ) ||
    (block.status !== "ok" &&
      block.status !== "plugin-missing" &&
      block.status !== "view-missing" &&
      block.status !== "invalid-payload") ||
    (block.label !== undefined && typeof block.label !== "string") ||
    (block.status === "ok" && !("payload" in block))
  ) {
    return undefined;
  }
  // SAFETY: The fields above validate the display envelope; the Gateway owns JSON payload admission.
  return block as PluginInlineViewBlock;
}

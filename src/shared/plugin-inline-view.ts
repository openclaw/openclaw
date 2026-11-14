import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { PluginJsonValue } from "../plugins/host-hook-json.js";

export const PLUGIN_INLINE_VIEW_MAX_BYTES = 16 * 1024;

/** Component/payload interface version, independent of the plugin package version. */
export function isPluginInlineViewVersion(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65535;
}

/** The durable display record. Availability is presentation state, never stored data. */
export type PluginInlineViewDescriptor = {
  pluginId: string;
  viewId: string;
  version: number;
  payload: PluginJsonValue;
  summary: string;
};
export type PluginInlineViewBlock = PluginInlineViewDescriptor & {
  type: "plugin_view";
  toolCallId: string;
  toolName: string;
};

/** Read the envelope; native tool admission owns bounded JSON validation. */
export function readPluginInlineViewDescriptor(
  value: unknown,
): PluginInlineViewDescriptor | undefined {
  const record = asOptionalRecord(value);
  if (
    !record ||
    !["pluginId", "viewId", "summary"].every(
      (key) => typeof record[key] === "string" && record[key].trim().length > 0,
    ) ||
    !isPluginInlineViewVersion(record.version) ||
    !("payload" in record)
  ) {
    return undefined;
  }
  // SAFETY: the envelope is checked above; host admission owns the JSON payload contract.
  return record as PluginInlineViewDescriptor;
}

/** Only the structured host projection is display input; never parse text or guest JSON. */
export function readPluginInlineViewBlock(value: unknown): PluginInlineViewBlock | undefined {
  const block = asOptionalRecord(value);
  if (
    block?.type !== "plugin_view" ||
    !readPluginInlineViewDescriptor(block) ||
    !["toolCallId", "toolName"].every(
      (key) => typeof block[key] === "string" && block[key].trim().length > 0,
    )
  ) {
    return undefined;
  }
  // SAFETY: the display envelope and invocation fields were checked above.
  return block as PluginInlineViewBlock;
}

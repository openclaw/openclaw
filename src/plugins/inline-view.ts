import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { AgentToolResult } from "../agents/runtime/index.js";
import {
  PLUGIN_INLINE_VIEW_MAX_BYTES,
  isPluginInlineViewVersion,
  readPluginInlineViewDescriptor,
  type PluginInlineViewDescriptor,
} from "../shared/plugin-inline-view.js";
import { isPluginJsonValue, type PluginJsonValue } from "./host-hook-json.js";

export type PluginInlineViewResult = {
  content: [{ type: "text"; text: string }];
  details: { pluginInlineView: PluginInlineViewDescriptor };
};

function isInlineViewPayload(value: unknown): value is PluginJsonValue {
  return (
    isPluginJsonValue(value) &&
    Buffer.byteLength(JSON.stringify(value), "utf8") <= PLUGIN_INLINE_VIEW_MAX_BYTES
  );
}

export function createPluginInlineViewResult(
  pluginId: string,
  viewId: string,
  payload: PluginJsonValue,
  options: { version: number; summary: string },
): PluginInlineViewResult {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(viewId)) {
    throw new Error("Inline view requires a registered view id.");
  }
  if (!isPluginInlineViewVersion(options.version)) {
    throw new Error("Inline view version must be an integer from 1 to 65535.");
  }
  if (typeof options.summary !== "string" || !options.summary.trim()) {
    throw new Error("Inline view requires a nonblank text summary.");
  }
  if (Buffer.byteLength(JSON.stringify(options.summary), "utf8") > 4096) {
    throw new Error("Inline view summary must be at most 4 KiB of serialized UTF-8 JSON.");
  }
  if (!isInlineViewPayload(payload)) {
    throw new Error(
      "Inline view payload must be plain JSON of at most 16 KiB UTF-8. Store larger data in the plugin and pass an id.",
    );
  }
  return {
    content: [{ type: "text", text: options.summary }],
    details: {
      pluginInlineView: {
        pluginId,
        viewId,
        version: options.version,
        payload,
        summary: options.summary,
      },
    },
  };
}

/** Bind display provenance at the native tool owner, before direct/nested transcript capture. */
export function bindPluginInlineViewInvocation<T extends AgentToolResult<unknown>>(
  result: T,
  pluginId: string,
  toolName: string,
  toolCallId: string,
): T {
  const details = asOptionalRecord(result.details);
  const descriptor = readPluginInlineViewDescriptor(details?.pluginInlineView);
  if (!descriptor || descriptor.pluginId !== pluginId) {
    return result;
  }
  return {
    ...result,
    details: {
      ...details,
      pluginInlineViewInvocation: { pluginId, toolName, toolCallId },
    },
  };
}

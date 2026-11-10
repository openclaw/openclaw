import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import {
  readPluginInlineViewBlock,
  readPluginInlineViewDescriptor,
  type PluginInlineViewBlock,
} from "../shared/plugin-inline-view.js";

type Invocation = Record<string, unknown>;

/** Preserve the admitted record regardless of installed renderers. The browser owns availability. */
export function projectPluginInlineView(
  details: unknown,
  invocation: Invocation,
): PluginInlineViewBlock | undefined {
  const record = asOptionalRecord(details);
  const descriptor = readPluginInlineViewDescriptor(record?.pluginInlineView);
  const owner = asOptionalRecord(record?.pluginInlineViewInvocation);
  const source =
    descriptor &&
    owner?.pluginId === descriptor.pluginId &&
    typeof owner.toolCallId === "string" &&
    typeof owner.toolName === "string"
      ? {
          type: "plugin_view" as const,
          ...descriptor,
          toolCallId: owner.toolCallId,
          toolName: owner.toolName,
        }
      : readPluginInlineViewBlock(record?.pluginView);
  const toolCallId = invocation.toolCallId ?? invocation.tool_call_id ?? invocation.id;
  const toolName = invocation.toolName ?? invocation.tool_name ?? invocation.name;
  return source?.toolCallId === toolCallId && source?.toolName === toolName ? source : undefined;
}

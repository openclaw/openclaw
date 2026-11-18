import { asOptionalObjectRecord } from "@openclaw/normalization-core/record-coerce";
import { Type } from "typebox";
import { Value } from "typebox/value";
import {
  AgentActivityItemSchema,
  type AgentActivityItem,
} from "../../packages/gateway-protocol/src/schema/logs-chat.js";
import type { ChatLog, ChatLogOperations } from "./components/chat-log.js";
import { formatPrimitiveString } from "./tui-formatters.js";
import type { AgentEvent } from "./tui-types.js";

// Live item telemetry is open; the history descriptor uses the same fields but is closed.
const liveActivitySchema = Type.Object(AgentActivityItemSchema.properties, {
  additionalProperties: true,
});

export function renderTuiActivityItem(params: {
  chatLog: Pick<ChatLogOperations, "startTool">;
  event: Pick<AgentEvent, "data" | "runId">;
  verboseLevel: string | undefined;
}): boolean {
  const item = params.event.data;
  if (
    !Value.Check(liveActivitySchema, item) ||
    (params.verboseLevel ?? "off") === "off" ||
    item.kind === "preamble" ||
    item.suppressChannelProgress
  ) {
    return false;
  }
  params.chatLog.startTool(
    item.toolCallId ?? item.itemId,
    item.name ?? item.title,
    undefined,
    params.event.runId,
    item,
  );
  return true;
}

export function renderTuiHistoryToolResult(params: {
  chatLog: Pick<ChatLog, "startTool">;
  message: Record<string, unknown>;
  items: AgentActivityItem[] | undefined;
  verboseLevel: string | undefined;
}): void {
  const { chatLog, message, items, verboseLevel } = params;
  const toolCallId = formatPrimitiveString(message.toolCallId, "");
  const toolName = formatPrimitiveString(message.toolName, "tool");
  const activity =
    items?.find((item) => item.toolCallId === toolCallId) ?? (items ? null : undefined);
  const component =
    activity === undefined
      ? chatLog.startTool(toolCallId, toolName, {})
      : chatLog.startTool(toolCallId, toolName, {}, undefined, activity);
  component.setResult(
    verboseLevel === "full"
      ? {
          content: Array.isArray(message.content) ? message.content : [],
          details: asOptionalObjectRecord(message.details),
        }
      : { content: [] },
    { isError: Boolean(message.isError) },
  );
}

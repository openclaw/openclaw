// Maps one transcript message entry to trajectory bundle events. Nested Code Mode calls become
// standard tool.call/tool.result events owned by the assistant entry that issued their outer
// call, so bundle readers see every tool call the run made.
import type { AgentMessage } from "../agents/runtime/index.js";
import { readOwnNestedToolActivity } from "../sessions/nested-tool-activity.js";

type TranscriptMessageEvent = [type: string, data: Record<string, unknown>];

function resolveMessageEventType(message: AgentMessage): string {
  if (message.role === "user") {
    return "user.message";
  }
  if (message.role === "assistant") {
    return "assistant.message";
  }
  if (message.role === "toolResult") {
    return "tool.result";
  }
  return `message.${message.role}`;
}

function extractAssistantToolCalls(
  message: AgentMessage,
): Array<{ id?: string; name?: string; arguments?: unknown; index: number }> {
  if (message.role !== "assistant" || !Array.isArray(message.content)) {
    return [];
  }
  return message.content.flatMap((block, index) => {
    if (!block || typeof block !== "object") {
      return [];
    }
    // SAFETY: block is a non-null object; every field below is type-checked before use.
    const typedBlock = block as {
      type?: unknown;
      id?: unknown;
      name?: unknown;
      arguments?: unknown;
      input?: unknown;
      parameters?: unknown;
    };
    const blockType =
      typeof typedBlock.type === "string" ? typedBlock.type.trim().toLowerCase() : "";
    if (blockType !== "toolcall" && blockType !== "tooluse" && blockType !== "functioncall") {
      return [];
    }
    return [
      {
        id: typeof typedBlock.id === "string" ? typedBlock.id : undefined,
        name: typeof typedBlock.name === "string" ? typedBlock.name : undefined,
        arguments: typedBlock.arguments ?? typedBlock.input ?? typedBlock.parameters,
        index,
      },
    ];
  });
}

/** `assistantEntryByCallId` carries call ownership across the entries of one branch. */
export function transcriptMessageEvents(
  entryId: string,
  message: AgentMessage,
  assistantEntryByCallId: Map<string, string>,
): TranscriptMessageEvent[] {
  const nested = readOwnNestedToolActivity(message)?.details;
  if (nested) {
    const { parentToolCallId, toolCallId, toolName } = nested;
    const assistantEntryId = parentToolCallId && assistantEntryByCallId.get(parentToolCallId);
    if (assistantEntryId) {
      assistantEntryByCallId.set(toolCallId, assistantEntryId);
    }
    return [
      [
        "tool.call",
        { toolCallId, name: toolName, arguments: nested.input, assistantEntryId, parentToolCallId },
      ],
      [
        "tool.result",
        {
          parentToolCallId,
          message: {
            role: "toolResult",
            toolCallId,
            toolName,
            ...nested.result,
            isError: nested.isError,
            timestamp: nested.timestamp,
          },
        },
      ],
    ];
  }
  const events: TranscriptMessageEvent[] = [[resolveMessageEventType(message), { message }]];
  for (const toolCall of extractAssistantToolCalls(message)) {
    if (toolCall.id) {
      assistantEntryByCallId.set(toolCall.id, entryId);
    }
    events.push([
      "tool.call",
      {
        toolCallId: toolCall.id,
        name: toolCall.name,
        arguments: toolCall.arguments,
        assistantEntryId: entryId,
        blockIndex: toolCall.index,
      },
    ]);
  }
  return events;
}

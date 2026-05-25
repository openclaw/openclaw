import { extractFirstTextBlock } from "../shared/chat-message-content.js";
import { isToolHistoryBlockType } from "./chat-display-projection.js";

type ChatHistoryRecord = Record<string, unknown>;

export type ChatHistoryTurnItem = {
  type: "turn";
  turnId: string;
  runId?: string;
  startedAt?: number;
  endedAt?: number;
  user?: ChatHistoryTurnMessageSummary;
  assistant?: ChatHistoryTurnMessageSummary & {
    content?: ChatHistoryRecord[];
    finalText?: string;
    provider?: string;
    model?: string;
    usage?: unknown;
  };
  tools?: ChatHistoryToolSummary;
  response?: ChatHistoryResponseSummary;
};

export type ChatHistoryTurnMessageSummary = {
  messageId?: string;
  preview: string;
  detailsRef: "chat.turnDetails";
};

export type ChatHistoryToolSummary = {
  count: number;
  names: string[];
  status: "completed" | "partial" | "unpaired";
  detailsRef: "chat.toolDetails";
};

export type ChatHistoryResponseSummary = {
  provider?: string;
  model?: string;
  status?: string;
  usage?: unknown;
  detailsRef: "chat.responseDetails";
};

export type ChatHistoryTurnsResult = {
  items: ChatHistoryTurnItem[];
  messages: ChatHistoryRecord[];
  meta: {
    rawMessagesMatched: number;
    displayItemsReturned: number;
    toolRecordsCollapsed: number;
    hasMoreBefore: boolean;
  };
};

type MutableTurn = ChatHistoryTurnItem & {
  sourceMessages: ChatHistoryRecord[];
  toolCallIds: Set<string>;
  toolResultIds: Set<string>;
  toolNames: Set<string>;
  collapsedToolRecordCount: number;
  hasUnpairedToolActivity: boolean;
};

const DEFAULT_PREVIEW_MAX_CHARS = 1_200;

function asRecord(value: unknown): ChatHistoryRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as ChatHistoryRecord)
    : null;
}

function normalizeRole(message: ChatHistoryRecord): string {
  return typeof message.role === "string" ? message.role.trim().toLowerCase() : "";
}

function contentBlocks(message: ChatHistoryRecord): ChatHistoryRecord[] {
  return Array.isArray(message.content)
    ? message.content.filter((block): block is ChatHistoryRecord => Boolean(asRecord(block)))
    : [];
}

function stringField(record: ChatHistoryRecord | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberField(record: ChatHistoryRecord | undefined, key: string): number | undefined {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function openclawMeta(message: ChatHistoryRecord): ChatHistoryRecord | undefined {
  return asRecord(message["__openclaw"]) ?? undefined;
}

function extractMirrorIdentityTurnId(message: ChatHistoryRecord): string | undefined {
  const mirrorIdentity = stringField(openclawMeta(message), "mirrorIdentity");
  if (!mirrorIdentity) {
    return undefined;
  }
  const index = mirrorIdentity.indexOf(":");
  const candidate = index >= 0 ? mirrorIdentity.slice(0, index) : mirrorIdentity;
  return candidate.trim() || undefined;
}

function extractTurnId(message: ChatHistoryRecord): string | undefined {
  return (
    stringField(message, "turnId") ??
    stringField(openclawMeta(message), "turnId") ??
    extractMirrorIdentityTurnId(message)
  );
}

function extractRunId(message: ChatHistoryRecord): string | undefined {
  return stringField(message, "runId") ?? stringField(openclawMeta(message), "runId");
}

function extractMessageId(message: ChatHistoryRecord): string | undefined {
  return (
    stringField(message, "id") ??
    stringField(message, "messageId") ??
    stringField(openclawMeta(message), "id")
  );
}

function truncatePreview(text: string, maxChars: number): string {
  const normalized = text.trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function extractTextPreview(message: ChatHistoryRecord, maxChars: number): string | undefined {
  const direct =
    typeof message.text === "string"
      ? message.text
      : typeof message.content === "string"
        ? message.content
        : extractFirstTextBlock(message);
  if (typeof direct === "string" && direct.trim()) {
    return truncatePreview(direct, maxChars);
  }
  return undefined;
}

function buildAssistantDisplayContent(
  message: ChatHistoryRecord,
  preview: string,
): ChatHistoryRecord[] {
  const content: ChatHistoryRecord[] = [{ type: "text", text: preview }];
  for (const block of contentBlocks(message)) {
    if (isToolBlock(block) || block.type === "text") {
      continue;
    }
    content.push(block);
  }
  return content;
}

function isToolBlock(block: ChatHistoryRecord): boolean {
  return isToolHistoryBlockType(block.type);
}

function isToolLikeMessage(message: ChatHistoryRecord): boolean {
  const role = normalizeRole(message);
  return (
    role === "tool" ||
    role === "toolresult" ||
    role === "tool_result" ||
    role === "function" ||
    stringField(message, "toolCallId") !== undefined ||
    stringField(message, "tool_call_id") !== undefined ||
    stringField(message, "toolName") !== undefined ||
    stringField(message, "tool_name") !== undefined ||
    contentBlocks(message).some(isToolBlock)
  );
}

function extractToolCallIdFromBlock(block: ChatHistoryRecord): string | undefined {
  return (
    stringField(block, "id") ??
    stringField(block, "toolCallId") ??
    stringField(block, "tool_call_id") ??
    stringField(block, "toolUseId") ??
    stringField(block, "tool_use_id")
  );
}

function extractToolCallIds(message: ChatHistoryRecord): string[] {
  const ids = [
    stringField(message, "toolCallId"),
    stringField(message, "tool_call_id"),
    stringField(message, "toolUseId"),
    stringField(message, "tool_use_id"),
    ...contentBlocks(message).map(extractToolCallIdFromBlock),
  ].filter((value): value is string => Boolean(value));
  return [...new Set(ids)];
}

function extractToolNameFromBlock(block: ChatHistoryRecord): string | undefined {
  return (
    stringField(block, "name") ?? stringField(block, "toolName") ?? stringField(block, "tool_name")
  );
}

function extractToolNames(message: ChatHistoryRecord): string[] {
  const names = [
    stringField(message, "toolName"),
    stringField(message, "tool_name"),
    stringField(message, "name"),
    ...contentBlocks(message).filter(isToolBlock).map(extractToolNameFromBlock),
  ].filter((value): value is string => Boolean(value));
  return [...new Set(names)];
}

function extractTimestamp(message: ChatHistoryRecord): number | undefined {
  return numberField(message, "timestamp") ?? numberField(openclawMeta(message), "timestamp");
}

function createTurn(turnId: string): MutableTurn {
  return {
    type: "turn",
    turnId,
    sourceMessages: [],
    toolCallIds: new Set(),
    toolResultIds: new Set(),
    toolNames: new Set(),
    collapsedToolRecordCount: 0,
    hasUnpairedToolActivity: false,
  };
}

function appendToolActivity(turn: MutableTurn, message: ChatHistoryRecord) {
  turn.collapsedToolRecordCount += 1;
  const normalizedRole = normalizeRole(message).replaceAll("_", "");
  const toolCallIds = extractToolCallIds(message);
  for (const id of toolCallIds) {
    if (normalizedRole === "toolresult" || normalizedRole === "tool") {
      turn.toolResultIds.add(id);
    } else {
      turn.toolCallIds.add(id);
    }
  }
  for (const name of extractToolNames(message)) {
    turn.toolNames.add(name);
  }
  if (toolCallIds.length === 0) {
    turn.hasUnpairedToolActivity = true;
  }
}

function updateTurnBounds(turn: MutableTurn, message: ChatHistoryRecord) {
  const timestamp = extractTimestamp(message);
  if (timestamp === undefined) {
    return;
  }
  turn.startedAt = turn.startedAt === undefined ? timestamp : Math.min(turn.startedAt, timestamp);
  turn.endedAt = turn.endedAt === undefined ? timestamp : Math.max(turn.endedAt, timestamp);
}

function addMessageToTurn(turn: MutableTurn, message: ChatHistoryRecord, maxPreviewChars: number) {
  turn.sourceMessages.push(message);
  updateTurnBounds(turn, message);
  turn.runId ??= extractRunId(message);

  const role = normalizeRole(message);
  const isToolLike = isToolLikeMessage(message);
  if (isToolLike) {
    appendToolActivity(turn, message);
  }

  if (role === "user") {
    const preview = extractTextPreview(message, maxPreviewChars);
    if (preview) {
      turn.user = {
        messageId: extractMessageId(message),
        preview,
        detailsRef: "chat.turnDetails",
      };
    }
    return;
  }

  if (role !== "assistant") {
    return;
  }

  const preview = extractTextPreview(message, maxPreviewChars);
  if (preview) {
    turn.assistant = {
      messageId: extractMessageId(message),
      preview,
      finalText: preview,
      content: buildAssistantDisplayContent(message, preview),
      provider: stringField(message, "provider"),
      model: stringField(message, "model"),
      usage: message.usage,
      detailsRef: "chat.turnDetails",
    };
    turn.response = {
      provider: stringField(message, "provider"),
      model: stringField(message, "model"),
      status: stringField(message, "stopReason") ?? stringField(message, "status") ?? "completed",
      usage: message.usage,
      detailsRef: "chat.responseDetails",
    };
  }
}

function finalizeTurn(turn: MutableTurn): ChatHistoryTurnItem | null {
  const pairedToolCount = Math.max(turn.toolCallIds.size, turn.toolResultIds.size);
  const toolCount = pairedToolCount > 0 ? pairedToolCount : turn.collapsedToolRecordCount;
  if (toolCount > 0) {
    const missingResults = [...turn.toolCallIds].some((id) => !turn.toolResultIds.has(id));
    const missingCalls = [...turn.toolResultIds].some((id) => !turn.toolCallIds.has(id));
    turn.tools = {
      count: toolCount,
      names: [...turn.toolNames].slice(0, 12),
      status:
        turn.hasUnpairedToolActivity || missingResults || missingCalls ? "unpaired" : "completed",
      detailsRef: "chat.toolDetails",
    };
  }

  if (!turn.user && !turn.assistant && !turn.tools) {
    return null;
  }

  const {
    sourceMessages,
    toolCallIds,
    toolResultIds,
    toolNames,
    collapsedToolRecordCount,
    hasUnpairedToolActivity,
    ...item
  } = turn;
  void sourceMessages;
  void toolCallIds;
  void toolResultIds;
  void toolNames;
  void collapsedToolRecordCount;
  void hasUnpairedToolActivity;
  return item;
}

function toolSummaryText(tools: ChatHistoryToolSummary): string {
  const names = tools.names.length > 0 ? `: ${tools.names.join(", ")}` : "";
  const status = tools.status === "completed" ? "" : ` (${tools.status})`;
  return `${tools.count} tool ${tools.count === 1 ? "activity" : "activities"}${names}${status}`;
}

function flattenTurnItemToMessages(item: ChatHistoryTurnItem): ChatHistoryRecord[] {
  const messages: ChatHistoryRecord[] = [];
  if (item.user) {
    const message: ChatHistoryRecord = {
      role: "user",
      content: [{ type: "text", text: item.user.preview }],
      __openclaw: { kind: "turn_user", turnId: item.turnId, messageId: item.user.messageId },
    };
    if (item.startedAt !== undefined) {
      message.timestamp = item.startedAt;
    }
    messages.push(message);
  }
  if (item.tools) {
    const message: ChatHistoryRecord = {
      role: "toolResult",
      toolName: "activity",
      content: [
        {
          type: "toolResult",
          name: "activity",
          content: toolSummaryText(item.tools),
          text: toolSummaryText(item.tools),
        },
      ],
      __openclaw: { kind: "turn_tool_summary", turnId: item.turnId, runId: item.runId },
    };
    const timestamp = item.endedAt ?? item.startedAt;
    if (timestamp !== undefined) {
      message.timestamp = timestamp;
    }
    messages.push(message);
  }
  if (item.assistant) {
    const message: ChatHistoryRecord = {
      role: "assistant",
      content: item.assistant.content ?? [
        { type: "text", text: item.assistant.finalText ?? item.assistant.preview },
      ],
      provider: item.assistant.provider,
      model: item.assistant.model,
      usage: item.assistant.usage,
      __openclaw: {
        kind: "turn_assistant",
        turnId: item.turnId,
        messageId: item.assistant.messageId,
      },
    };
    const timestamp = item.endedAt ?? item.startedAt;
    if (timestamp !== undefined) {
      message.timestamp = timestamp;
    }
    messages.push(message);
  }
  return messages;
}

export function projectChatHistoryTurns(
  messages: unknown[],
  options?: { dropLeadingPartialTurn?: boolean; maxTurns?: number; maxPreviewChars?: number },
): ChatHistoryTurnsResult {
  const maxTurns =
    typeof options?.maxTurns === "number" && Number.isFinite(options.maxTurns)
      ? Math.max(1, Math.floor(options.maxTurns))
      : 50;
  const maxPreviewChars =
    typeof options?.maxPreviewChars === "number" && Number.isFinite(options.maxPreviewChars)
      ? Math.max(1, Math.floor(options.maxPreviewChars))
      : DEFAULT_PREVIEW_MAX_CHARS;

  const turns: MutableTurn[] = [];
  let current: MutableTurn | undefined;
  let fallbackTurnIndex = 0;

  for (const value of messages) {
    const message = asRecord(value);
    if (!message) {
      continue;
    }
    const role = normalizeRole(message);
    const explicitTurnId = extractTurnId(message);
    const turnId =
      explicitTurnId ??
      (role === "user" || !current ? `history-turn-${fallbackTurnIndex}` : current.turnId);
    const shouldStartTurn = role === "user" || !current || current.turnId !== turnId;
    if (shouldStartTurn) {
      current = createTurn(turnId);
      turns.push(current);
      if (!explicitTurnId) {
        fallbackTurnIndex += 1;
      }
    }
    if (!current) {
      continue;
    }
    addMessageToTurn(current, message, maxPreviewChars);
  }

  const allItems = turns.flatMap((turn) => {
    const item = finalizeTurn(turn);
    return item ? [{ item, toolRecordsCollapsed: turn.collapsedToolRecordCount }] : [];
  });
  const candidateItems =
    options?.dropLeadingPartialTurn === true && allItems[0] && !allItems[0].item.user
      ? allItems.slice(1)
      : allItems;
  const items = candidateItems.slice(-maxTurns);
  const turnItems = items.map((entry) => entry.item);
  const messagesOut = turnItems.flatMap((item) => flattenTurnItemToMessages(item));
  const toolRecordsCollapsed = items.reduce((sum, entry) => sum + entry.toolRecordsCollapsed, 0);

  return {
    items: turnItems,
    messages: messagesOut,
    meta: {
      rawMessagesMatched: messages.filter((message) => Boolean(asRecord(message))).length,
      displayItemsReturned: turnItems.length,
      toolRecordsCollapsed,
      hasMoreBefore: allItems.length > items.length,
    },
  };
}

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { TextContent, ToolResultMessage } from "@mariozechner/pi-ai";
import { microcompactLog } from "./logger.js";

export interface MicrocompactConfig {
  enabled: boolean;
  cacheBased: {
    enabled: boolean;
    maxCachedResults: number;
    minToolCalls: number;
  };
  timeBased: {
    enabled: boolean;
    gapThresholdMinutes: number;
    maxCachedResults: number;
  };
}

export const DEFAULT_MICROCOMPACT_CONFIG: MicrocompactConfig = {
  enabled: true,
  cacheBased: {
    enabled: true,
    maxCachedResults: 3,
    minToolCalls: 3,
  },
  timeBased: {
    enabled: true,
    gapThresholdMinutes: 30,
    maxCachedResults: 3,
  },
};

export const COMPACTABLE_TOOLS = new Set<string>([
  "read",
  "bash",
  "grep",
  "glob",
  "web_fetch",
  "web_search",
  "memory_search",
  "memory_get",
  "feishu_doc.read",
  "feishu_bitable_list_records",
]);

function isToolResultMessage(message: AgentMessage): message is ToolResultMessage<unknown> {
  return (
    typeof message === "object" &&
    message !== null &&
    "role" in message &&
    (message as { role?: unknown }).role === "toolResult"
  );
}

function estimateContentSize(content: unknown): number {
  if (content == null) {
    return 0;
  }
  if (typeof content === "string") {
    return content.length;
  }
  if (Array.isArray(content)) {
    return content.reduce((sum, item) => sum + estimateContentSize(item), 0);
  }
  if (typeof content === "object") {
    if ("text" in (content as Record<string, unknown>)) {
      const text = (content as { text?: unknown }).text;
      return typeof text === "string" ? text.length : 0;
    }
    try {
      return JSON.stringify(content).length;
    } catch {
      return 0;
    }
  }
  if (typeof content === "number" || typeof content === "boolean" || typeof content === "bigint") {
    return String(content).length;
  }
  return 0;
}

function compactedText(toolName: string, content: unknown): TextContent {
  return {
    type: "text",
    text: `[Tool Result: ${toolName} (${estimateContentSize(content)} bytes)]`,
  };
}

function cloneCompactedToolResult(
  message: ToolResultMessage<unknown>,
  toolName: string,
): ToolResultMessage<unknown> {
  return {
    ...message,
    content: [compactedText(toolName, message.content)],
  };
}

function collectCompactableResults(
  messages: AgentMessage[],
): Map<string, ToolResultMessage<unknown>[]> {
  const grouped = new Map<string, ToolResultMessage<unknown>[]>();
  for (const message of messages) {
    if (!isToolResultMessage(message)) {
      continue;
    }
    const toolName = typeof message.toolName === "string" ? message.toolName : "";
    if (!toolName || !COMPACTABLE_TOOLS.has(toolName)) {
      continue;
    }
    const existing = grouped.get(toolName) ?? [];
    existing.push(message);
    grouped.set(toolName, existing);
  }
  return grouped;
}

export async function applyCacheBasedCompact(
  messages: AgentMessage[],
  maxCachedResults = 3,
  minToolCalls = 3,
): Promise<AgentMessage[]> {
  const grouped = collectCompactableResults(messages);
  const targets = new Map<ToolResultMessage<unknown>, string>();

  for (const [toolName, toolResults] of grouped.entries()) {
    if (toolResults.length < minToolCalls) {
      continue;
    }
    const keepFrom = Math.max(0, toolResults.length - maxCachedResults);
    for (let i = 0; i < keepFrom; i += 1) {
      targets.set(toolResults[i], toolName);
    }
  }

  if (targets.size === 0) {
    return messages;
  }

  microcompactLog.info(`cache-based compacting ${targets.size} tool result message(s)`);
  return messages.map((message) => {
    if (!isToolResultMessage(message)) {
      return message;
    }
    const toolName = targets.get(message);
    return toolName ? cloneCompactedToolResult(message, toolName) : message;
  });
}

function toTimestampMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (value instanceof Date) {
    return value.getTime();
  }
  return null;
}

export async function evaluateTimeBasedTrigger(
  messages: AgentMessage[],
  gapThresholdMinutes = 30,
): Promise<string[]> {
  const grouped = collectCompactableResults(messages);
  const thresholdMs = gapThresholdMinutes * 60 * 1000;
  const triggered: string[] = [];

  for (const [toolName, toolResults] of grouped.entries()) {
    const timestamps = toolResults
      .map((message) => toTimestampMs(message.timestamp))
      .filter((value): value is number => value !== null)
      .toSorted((a, b) => a - b);

    for (let i = 1; i < timestamps.length; i += 1) {
      if (timestamps[i] - timestamps[i - 1] >= thresholdMs) {
        triggered.push(toolName);
        break;
      }
    }
  }

  return triggered;
}

export async function applyTimeBasedCompact(
  messages: AgentMessage[],
  gapThresholdMinutes = 30,
  maxCachedResults = 3,
): Promise<AgentMessage[]> {
  const triggeredTools = new Set(await evaluateTimeBasedTrigger(messages, gapThresholdMinutes));
  if (triggeredTools.size === 0) {
    return messages;
  }

  const grouped = collectCompactableResults(messages);
  const targets = new Map<ToolResultMessage<unknown>, string>();
  for (const [toolName, toolResults] of grouped.entries()) {
    if (!triggeredTools.has(toolName)) {
      continue;
    }
    const keepFrom = Math.max(0, toolResults.length - maxCachedResults);
    for (let i = 0; i < keepFrom; i += 1) {
      targets.set(toolResults[i], toolName);
    }
  }

  if (targets.size === 0) {
    return messages;
  }

  microcompactLog.info(`time-based compacting ${targets.size} tool result message(s)`);
  return messages.map((message) => {
    if (!isToolResultMessage(message)) {
      return message;
    }
    const toolName = targets.get(message);
    return toolName ? cloneCompactedToolResult(message, toolName) : message;
  });
}

export async function applyMicrocompact(
  messages: AgentMessage[],
  config: MicrocompactConfig = DEFAULT_MICROCOMPACT_CONFIG,
): Promise<AgentMessage[]> {
  if (!config.enabled || messages.length === 0) {
    return messages;
  }

  let nextMessages = messages;
  if (config.cacheBased.enabled) {
    nextMessages = await applyCacheBasedCompact(
      nextMessages,
      config.cacheBased.maxCachedResults,
      config.cacheBased.minToolCalls,
    );
  }
  if (config.timeBased.enabled) {
    nextMessages = await applyTimeBasedCompact(
      nextMessages,
      config.timeBased.gapThresholdMinutes,
      config.timeBased.maxCachedResults,
    );
  }
  return nextMessages;
}

export default {
  DEFAULT_MICROCOMPACT_CONFIG,
  COMPACTABLE_TOOLS,
  applyCacheBasedCompact,
  applyTimeBasedCompact,
  applyMicrocompact,
  evaluateTimeBasedTrigger,
};

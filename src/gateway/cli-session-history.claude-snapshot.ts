import fs from "node:fs";
import readline from "node:readline";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { CliSessionReseedReceipt } from "../config/sessions.js";
import { normalizeCliSessionReseedReceipt } from "../config/sessions/cli-session-binding.js";
import {
  appendCoalescedClaudeCliToolMessage,
  createClaudeReseedImportState,
  decodeClaudeCliProjectEntry,
  type ClaudeCliProjectEntry,
  parseClaudeCliHistoryEntry,
  redactClaudeCliHistoryMessage,
  resolveClaudeCliSessionFilePathAsync,
} from "./cli-session-history.claude.js";

const YIELD_BYTES = 256 * 1024;
const OVERSIZED_JSONL_LINE_CHARS = 1024 * 1024;
const OVERSIZED_HISTORY_PLACEHOLDER =
  "[Claude CLI history record omitted from context because it exceeded 1 MiB.]";
type Message = Record<string, unknown>;
export type ClaudeCliHistoryParams = {
  cliSessionId: string;
  homeDir?: string;
  localSessionId?: string;
  reseedReceipt?: CliSessionReseedReceipt;
};

function projectOversizedClaudeEntry(entry: ClaudeCliProjectEntry): ClaudeCliProjectEntry | null {
  const type = entry.type;
  const message = asOptionalRecord(entry.message);
  if ((type !== "user" && type !== "assistant") || !message || message.role !== type) {
    return null;
  }
  const boundedString = (value: unknown, max: number) =>
    typeof value === "string" && value.length <= max ? value : undefined;
  let content: string | Message[] = OVERSIZED_HISTORY_PLACEHOLDER;
  if (type === "user" && Array.isArray(message.content) && message.content.length) {
    const toolResults: Message[] = [];
    for (const value of message.content) {
      const block = asOptionalRecord(value);
      const toolUseId = boundedString(block?.tool_use_id, 1_024);
      if (block?.type !== "tool_result" || !toolUseId) {
        toolResults.length = 0;
        break;
      }
      if (toolResults.length < 64) {
        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUseId,
          ...(block.is_error === true ? { is_error: true } : {}),
          content: OVERSIZED_HISTORY_PLACEHOLDER,
        });
      }
    }
    // An oversized tool result stays a tool result, never a synthetic user turn.
    if (toolResults.length) {
      content = toolResults;
    }
  }
  const rawUsage = asOptionalRecord(message.usage);
  const usage = rawUsage
    ? Object.fromEntries(
        [
          "input_tokens",
          "output_tokens",
          "cache_read_input_tokens",
          "cache_creation_input_tokens",
        ].flatMap((key) => (Number.isFinite(rawUsage[key]) ? [[key, rawUsage[key]]] : [])),
      )
    : undefined;
  return {
    type,
    timestamp: boundedString(entry.timestamp, 128),
    uuid: boundedString(entry.uuid, 1_024),
    isSidechain: entry.isSidechain === true,
    isMeta: entry.isMeta === true,
    isCompactSummary: entry.isCompactSummary === true,
    isVisibleInTranscriptOnly: entry.isVisibleInTranscriptOnly === true,
    message: {
      role: type,
      content,
      model: boundedString(message.model, 256),
      stop_reason: boundedString(message.stop_reason, 128),
      usage,
    },
  };
}

export async function resolveClaudeCliHistorySource(
  params: ClaudeCliHistoryParams,
): Promise<readonly [filePath: string, cacheKey: string, byteLength: number] | undefined> {
  const candidate = await resolveClaudeCliSessionFilePathAsync(params);
  if (!candidate) {
    return undefined;
  }
  try {
    const filePath = await fs.promises.realpath(candidate);
    const stats = await fs.promises.stat(filePath);
    const sourceFingerprint = [stats.dev, stats.ino, stats.size, stats.mtimeMs, stats.ctimeMs].join(
      ":",
    );
    const cacheKey = JSON.stringify([
      filePath,
      sourceFingerprint,
      params.cliSessionId,
      params.localSessionId?.trim() || null,
      normalizeCliSessionReseedReceipt(params.reseedReceipt),
    ]);
    return [filePath, cacheKey, stats.size];
  } catch {
    return undefined;
  }
}

export async function visitClaudeCliSessionMessages(
  filePath: string,
  params: ClaudeCliHistoryParams,
  visit: (message: Message) => void,
  byteLength?: number,
): Promise<void> {
  if (byteLength === 0) {
    return;
  }
  const messages: Message[] = [];
  const toolNames = new Map<string, string>();
  const lines = readline.createInterface({
    input: fs.createReadStream(filePath, {
      encoding: "utf8",
      ...(byteLength === undefined ? {} : { end: byteLength - 1 }),
    }),
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  const reseedState = createClaudeReseedImportState(params);
  let bytesSinceYield = 0;
  let lineNumber = 0;
  // Production imports already run in the history worker. A pathological decode can
  // fail that read under its heap limit; the external transcript is never changed.
  for await (const line of lines) {
    lineNumber += 1;
    const oversized = line.length > OVERSIZED_JSONL_LINE_CHARS;
    if (oversized) {
      bytesSinceYield = 0;
      await yieldToEventLoop();
    } else {
      bytesSinceYield += Buffer.byteLength(line, "utf8") + 1;
      if (bytesSinceYield >= YIELD_BYTES) {
        bytesSinceYield = 0;
        await yieldToEventLoop();
      }
      if (!line.trim()) {
        continue;
      }
    }
    let parsedMessage: Message | null = null;
    try {
      const decoded = decodeClaudeCliProjectEntry(line);
      const entry = oversized ? projectOversizedClaudeEntry(decoded) : decoded;
      if (!entry) {
        continue;
      }
      parsedMessage = parseClaudeCliHistoryEntry(
        entry,
        params.cliSessionId,
        lineNumber,
        toolNames,
        { reseedMode: "recover", reseedState },
      );
    } catch {
      // Ignore malformed external history entries.
    }
    if (parsedMessage) {
      appendCoalescedClaudeCliToolMessage(messages, parsedMessage);
      if (messages.length > 1) {
        visit(redactClaudeCliHistoryMessage(messages.shift()!));
      }
    }
  }
  for (const message of messages) {
    visit(redactClaudeCliHistoryMessage(message));
  }
}

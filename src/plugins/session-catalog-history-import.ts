import { parseDateStringTimestampMs } from "@openclaw/normalization-core/number-coercion";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import type {
  SessionCatalogTranscriptItem,
  SessionsCatalogReadResult,
} from "../../packages/gateway-protocol/src/schema/sessions-catalog.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { AgentMessage } from "../plugin-sdk/agent-core.js";
import { withSessionTranscriptWriteLock } from "../plugin-sdk/session-transcript-runtime.js";

const SESSION_CATALOG_HISTORY_IMPORT_MAX_ITEMS = 200;
const SESSION_CATALOG_HISTORY_IMPORT_MAX_BYTES = 512 * 1024;
const SESSION_CATALOG_HISTORY_IMPORT_PAGE_LIMIT = 100;

function importedSessionCatalogMessages(params: {
  catalogId: string;
  item: SessionCatalogTranscriptItem;
  fallbackTimestamp: number;
}): AgentMessage[] {
  const timestamp = parseDateStringTimestampMs(params.item.timestamp) ?? params.fallbackTimestamp;
  const importedText = params.item.text?.trim();
  if (!importedText && params.item.type === "reasoning") {
    return [];
  }
  const toolInput = asNullableRecord(params.item.toolInput);
  const nonObjectInput = params.item.toolInput !== undefined && !toolInput;
  // Native toolCall blocks require object arguments. Keep other JSON inputs
  // visible as labelled text instead of inventing a different argument shape.
  const text =
    params.item.type === "toolCall" && nonObjectInput
      ? `${params.item.toolName ?? "tool"}\n\n${JSON.stringify(params.item.toolInput, null, 2)}`
      : importedText || "[Unsupported catalog transcript item]";
  if (params.item.type === "userMessage") {
    // Imported native rows are not OpenClaw-authored; mirrorOrigin excludes them
    // from self-echo provenance so a repeated external prompt stays observable.
    return [
      {
        role: "user",
        content: text,
        timestamp,
        __openclaw: { mirrorOrigin: `${params.catalogId}-catalog-import` },
      } as AgentMessage,
    ];
  }
  if (params.item.type === "toolResult" && params.item.toolName && params.item.toolCallId) {
    const result: AgentMessage = {
      role: "toolResult",
      toolCallId: params.item.toolCallId,
      toolName: params.item.toolName,
      content: [{ type: "text", text: params.item.text ?? "" }],
      isError: params.item.isError === true,
      ...(params.item.exitCode !== undefined
        ? { details: { exitCode: params.item.exitCode } }
        : {}),
      timestamp,
    };
    // Some native stores retain one completed item with both input and output.
    // Expand it only at import so catalog cursors still count native items.
    return params.item.toolInput !== undefined
      ? [
          ...importedSessionCatalogMessages({
            ...params,
            item: { ...params.item, type: "toolCall" },
          }),
          result,
        ]
      : [result];
  }
  const prefix =
    params.item.type === "toolCall" && (!params.item.toolName || nonObjectInput)
      ? "Tool call\n\n"
      : params.item.type === "toolResult"
        ? "Tool result\n\n"
        : params.item.type === "other"
          ? "Other\n\n"
          : "";
  const content =
    params.item.type === "reasoning"
      ? [{ type: "thinking" as const, thinking: text }]
      : params.item.type === "toolCall" && params.item.toolName && !nonObjectInput
        ? [
            {
              type: "toolCall" as const,
              id: params.item.toolCallId ?? `${params.catalogId}:${params.item.id ?? timestamp}`,
              name: params.item.toolName,
              arguments: toolInput ?? {},
            },
          ]
        : [{ type: "text" as const, text: `${prefix}${text}` }];
  return [
    {
      role: "assistant",
      content,
      timestamp,
      api: "openai-responses",
      provider: params.catalogId,
      model: params.item.model ?? "native-history",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
    },
  ];
}

function sessionCatalogContinuationNotice(text: string, timestamp: number): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    timestamp,
    api: "openai-responses",
    provider: "openclaw",
    model: "session-catalog",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
  };
}

function fitSessionCatalogItemToBytes(
  item: SessionCatalogTranscriptItem,
  maxBytes: number,
): SessionCatalogTranscriptItem | undefined {
  if (Buffer.byteLength(JSON.stringify(item), "utf8") <= maxBytes) {
    return item;
  }
  let retainedItem = item;
  // Text truncation cannot shrink structured input. Keep the visible result
  // with an explicit omission notice when that input alone exhausts the budget.
  if (
    item.toolInput !== undefined &&
    Buffer.byteLength(JSON.stringify({ ...item, text: "…", truncated: true }), "utf8") > maxBytes
  ) {
    const { toolInput: _toolInput, ...withoutInput } = item;
    retainedItem = {
      ...withoutInput,
      ...(item.type === "toolCall" ? { toolName: undefined } : {}),
      text: `${item.text ?? item.toolName ?? "Tool call"}\n\n[Oversized tool input omitted]`,
      truncated: true,
    };
    if (Buffer.byteLength(JSON.stringify(retainedItem), "utf8") <= maxBytes) {
      return retainedItem;
    }
  }
  const text = retainedItem.text;
  if (typeof text !== "string") {
    return undefined;
  }
  const candidate = (length: number): SessionCatalogTranscriptItem => {
    const safeLength =
      length > 0 && /[\uD800-\uDBFF]/u.test(text.charAt(length - 1)) ? length - 1 : length;
    return { ...retainedItem, text: `${text.slice(0, safeLength)}…`, truncated: true };
  };
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(JSON.stringify(candidate(middle)), "utf8") <= maxBytes) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  const bounded = candidate(low);
  return Buffer.byteLength(JSON.stringify(bounded), "utf8") <= maxBytes ? bounded : undefined;
}

function importableSessionCatalogItem(
  item: SessionCatalogTranscriptItem,
): SessionCatalogTranscriptItem {
  const { raw: _raw, ...importable } = item;
  return importable;
}

async function readBoundedSessionCatalogHistory(params: {
  read: (params: { cursor?: string; limit: number }) => Promise<SessionsCatalogReadResult>;
}): Promise<SessionCatalogTranscriptItem[]> {
  const items: SessionCatalogTranscriptItem[] = [];
  let cursor: string | undefined;
  let bytes = 0;
  while (items.length < SESSION_CATALOG_HISTORY_IMPORT_MAX_ITEMS) {
    const page = await params.read({
      limit: Math.min(
        SESSION_CATALOG_HISTORY_IMPORT_PAGE_LIMIT,
        SESSION_CATALOG_HISTORY_IMPORT_MAX_ITEMS - items.length,
      ),
      ...(cursor ? { cursor } : {}),
    });
    // Catalog reads are newest-first. Bound that recent suffix before restoring
    // source order for persistence; timestamps do not define transcript order.
    for (const item of page.items) {
      const importableItem = importableSessionCatalogItem(item);
      const itemBytes = Buffer.byteLength(JSON.stringify(importableItem), "utf8");
      const remainingBytes = SESSION_CATALOG_HISTORY_IMPORT_MAX_BYTES - bytes;
      if (items.length > 0 && itemBytes > remainingBytes) {
        return items.toReversed();
      }
      const retainedItem =
        itemBytes <= remainingBytes
          ? importableItem
          : fitSessionCatalogItemToBytes(importableItem, remainingBytes);
      if (!retainedItem) {
        continue;
      }
      const retainedItemBytes = Buffer.byteLength(JSON.stringify(retainedItem), "utf8");
      items.push(retainedItem);
      bytes += retainedItemBytes;
      if (
        items.length === SESSION_CATALOG_HISTORY_IMPORT_MAX_ITEMS ||
        bytes === SESSION_CATALOG_HISTORY_IMPORT_MAX_BYTES
      ) {
        return items.toReversed();
      }
    }
    if (!page.nextCursor || page.nextCursor === cursor) {
      break;
    }
    cursor = page.nextCursor;
  }
  return items.toReversed();
}

export async function importSessionCatalogHistory(params: {
  catalogId: string;
  threadId: string;
  read: (params: { cursor?: string; limit: number }) => Promise<SessionsCatalogReadResult>;
  sessionId: string;
  sessionKey: string;
  agentId: string;
  cwd?: string;
  config: OpenClawConfig;
  continuationNotice?: string;
  commitGuard?: () => void;
}): Promise<void> {
  const items = await readBoundedSessionCatalogHistory({ read: params.read });
  const fallbackTimestamp = Date.now();
  await withSessionTranscriptWriteLock(params, async (transcript) => {
    for (const [index, item] of items.entries()) {
      const messages = importedSessionCatalogMessages({
        catalogId: params.catalogId,
        item,
        fallbackTimestamp: fallbackTimestamp + index,
      });
      for (const imported of messages) {
        const kind =
          messages.length === 2 && imported.role === "assistant" ? "catalog-tool-call" : "catalog";
        await transcript.appendMessage({
          message: {
            ...imported,
            idempotencyKey: `${params.catalogId}-${kind}:${params.threadId}:${item.id ?? index}`,
          },
          idempotencyLookup: "scan",
          cwd: params.cwd,
          ...(params.commitGuard ? { beforeCommitInTransaction: params.commitGuard } : {}),
        });
      }
    }
    const notice = params.continuationNotice?.trim();
    if (notice) {
      await transcript.appendMessage({
        message: {
          ...sessionCatalogContinuationNotice(notice, fallbackTimestamp + items.length),
          idempotencyKey: `${params.catalogId}-catalog:${params.threadId}:continuation-notice`,
        },
        idempotencyLookup: "scan",
        cwd: params.cwd,
        ...(params.commitGuard ? { beforeCommitInTransaction: params.commitGuard } : {}),
      });
    }
  });
}

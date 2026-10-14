import { createHash } from "node:crypto";
import { parseDateStringTimestampMs } from "@openclaw/normalization-core/number-coercion";
import type {
  SessionCatalogTranscriptItem,
  SessionsCatalogReadResult,
} from "../../packages/gateway-protocol/src/schema/sessions-catalog.js";
import { makeZeroUsageSnapshot } from "../agents/usage.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { AgentMessage } from "../plugin-sdk/agent-core.js";
import { withSessionTranscriptWrite } from "../plugin-sdk/session-transcript-runtime.js";
import { wrapExternalContent } from "../security/external-content.js";

const SESSION_CATALOG_CONTINUATION_LIMITS = { maxItems: 200, maxBytes: 512 * 1024 };
export const SESSION_CATALOG_TRANSCRIPT_IMPORT_LIMITS = {
  maxItems: 50_000,
  maxBytes: 64 * 1024 * 1024,
} as const;

type SessionCatalogHistory = {
  /** Retained source items in oldest-first order. */
  items: SessionCatalogTranscriptItem[];
  /** Items fetched, including the unretained remainder of the final page. */
  totalItems: number;
  complete: boolean;
};
// Claude and Codex transcript reads reject pages above 50 items; stay within every provider's cap.
const SESSION_CATALOG_HISTORY_IMPORT_PAGE_LIMIT = 50;

function importedSessionCatalogMessage(params: {
  catalogId: string;
  item: SessionCatalogTranscriptItem;
  fallbackTimestamp: number;
}): AgentMessage | undefined {
  const timestamp = parseDateStringTimestampMs(params.item.timestamp) ?? params.fallbackTimestamp;
  const importedText = params.item.text?.trim();
  if (!importedText && params.item.type === "reasoning") {
    return undefined;
  }
  const text = importedText || "[Unsupported catalog transcript item]";
  if (params.item.type === "userMessage") {
    // Imported native rows are not OpenClaw-authored; mirrorOrigin excludes them
    // from self-echo provenance so a repeated external prompt stays observable.
    return {
      role: "user",
      content: text,
      timestamp,
      __openclaw: { mirrorOrigin: `${params.catalogId}-catalog-import` },
    } as AgentMessage;
  }
  const prefix =
    params.item.type === "reasoning"
      ? "Thinking\n\n"
      : params.item.type === "toolCall"
        ? "Tool call\n\n"
        : params.item.type === "toolResult"
          ? "Tool result\n\n"
          : params.item.type === "other"
            ? "Other\n\n"
            : "";
  return sessionCatalogAssistantMessage(
    `${prefix}${text}`,
    timestamp,
    params.catalogId,
    params.item.model ?? "native-history",
  );
}

function sessionCatalogAssistantMessage(
  text: string,
  timestamp: number,
  provider: string,
  model: string,
): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    timestamp,
    api: "openai-responses",
    provider,
    model,
    usage: makeZeroUsageSnapshot(),
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
  const text = item.text;
  if (typeof text !== "string") {
    return undefined;
  }
  const candidate = (length: number): SessionCatalogTranscriptItem => {
    const safeLength =
      length > 0 && /[\uD800-\uDBFF]/u.test(text.charAt(length - 1)) ? length - 1 : length;
    return { ...item, text: `${text.slice(0, safeLength)}…`, truncated: true };
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

export async function readBoundedSessionCatalogHistory(params: {
  read: (params: { cursor?: string; limit: number }) => Promise<SessionsCatalogReadResult>;
  limits: { maxItems: number; maxBytes: number };
}): Promise<SessionCatalogHistory> {
  const items: SessionCatalogTranscriptItem[] = [];
  let cursor: string | undefined;
  let bytes = 0;
  let totalItems = 0;
  let complete = true;
  const result = (retainedAll: boolean): SessionCatalogHistory => ({
    items: items.toReversed(),
    totalItems,
    complete: complete && retainedAll,
  });
  while (items.length < params.limits.maxItems) {
    const page = await params.read({
      limit: Math.min(
        SESSION_CATALOG_HISTORY_IMPORT_PAGE_LIMIT,
        params.limits.maxItems - items.length,
      ),
      ...(cursor ? { cursor } : {}),
    });
    totalItems += page.items.length;
    // Catalog reads are newest-first. Bound that recent suffix before restoring
    // source order for persistence; timestamps do not define transcript order.
    for (const [index, item] of page.items.entries()) {
      const { raw: _raw, ...importableItem } = item;
      const itemBytes = Buffer.byteLength(JSON.stringify(importableItem), "utf8");
      const remainingBytes = params.limits.maxBytes - bytes;
      if (items.length > 0 && itemBytes > remainingBytes) {
        return result(false);
      }
      const retainedItem =
        itemBytes <= remainingBytes
          ? importableItem
          : fitSessionCatalogItemToBytes(importableItem, remainingBytes);
      if (retainedItem !== importableItem) {
        complete = false;
      }
      if (!retainedItem) {
        continue;
      }
      const retainedItemBytes = Buffer.byteLength(JSON.stringify(retainedItem), "utf8");
      items.push(retainedItem);
      bytes += retainedItemBytes;
      if (items.length === params.limits.maxItems || bytes === params.limits.maxBytes) {
        return result(index === page.items.length - 1 && !page.nextCursor);
      }
    }
    if (!page.nextCursor) {
      return result(true);
    }
    if (page.nextCursor === cursor) {
      return result(false);
    }
    cursor = page.nextCursor;
  }
  return result(false);
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
  const { items } = await readBoundedSessionCatalogHistory({
    read: params.read,
    limits: SESSION_CATALOG_CONTINUATION_LIMITS,
  });
  const fallbackTimestamp = Date.now();
  await withSessionTranscriptWrite(params, async (transcript) => {
    for (const [index, item] of items.entries()) {
      const imported = importedSessionCatalogMessage({
        catalogId: params.catalogId,
        item,
        fallbackTimestamp: fallbackTimestamp + index,
      });
      if (!imported) {
        continue;
      }
      const message = {
        ...imported,
        idempotencyKey: `${params.catalogId}-catalog:${params.threadId}:${item.id ?? index}`,
      };
      await transcript.appendMessage({
        message,
        idempotencyLookup: "scan",
        cwd: params.cwd,
        ...(params.commitGuard ? { preparation: { source: params.commitGuard } } : {}),
      });
    }
    const notice = params.continuationNotice?.trim();
    if (notice) {
      await transcript.appendMessage({
        message: {
          ...sessionCatalogAssistantMessage(
            notice,
            fallbackTimestamp + items.length,
            "openclaw",
            "session-catalog",
          ),
          idempotencyKey: `${params.catalogId}-catalog:${params.threadId}:continuation-notice`,
        },
        idempotencyLookup: "scan",
        cwd: params.cwd,
        ...(params.commitGuard ? { preparation: { source: params.commitGuard } } : {}),
      });
    }
  });
}

/** Preserve a prepared catalog snapshot without binding the session to its source runtime. */
export async function preserveSessionCatalogHistory(params: {
  catalogId: string;
  threadId: string;
  history: SessionCatalogHistory;
  sessionId: string;
  sessionKey: string;
  agentId: string;
  config: OpenClawConfig;
  notice: string;
  commitGuard?: () => void;
}): Promise<{ importedItems: number }> {
  const fallbackTimestamp = Date.now();
  const occurrences = new Map<string, number>();
  let importedItems = 0;
  params.commitGuard?.();
  await withSessionTranscriptWrite(params, async (transcript) => {
    params.commitGuard?.();
    await transcript.appendMessage({
      message: {
        ...sessionCatalogAssistantMessage(
          params.notice,
          fallbackTimestamp,
          "openclaw",
          "session-catalog",
        ),
        idempotencyKey: "catalog-preservation:notice",
      },
      idempotencyLookup: "scan",
      // Replays retain the first notice's timestamp, just as source items retain
      // their first fallback timestamp and randomized untrusted-content boundary.
      preparation: {
        prepareMessage: async (message) => message,
        source: params.commitGuard,
      },
    });
    for (const [index, item] of params.history.items.entries()) {
      const imported = importedSessionCatalogMessage({
        catalogId: params.catalogId,
        item,
        fallbackTimestamp: fallbackTimestamp + index + 1,
      });
      if (!imported) {
        continue;
      }
      let identity: (string | number)[];
      if (item.id) {
        identity = ["id", item.id];
      } else {
        const hash = createHash("sha256")
          .update(
            JSON.stringify([
              item.type,
              item.text ?? null,
              item.timestamp ?? null,
              item.model ?? null,
            ]),
          )
          .digest("hex");
        const ordinal = occurrences.get(hash) ?? 0;
        occurrences.set(hash, ordinal + 1);
        identity = ["content", hash, ordinal];
      }
      const idempotencyKey = `catalog-preservation:${JSON.stringify([params.catalogId, params.threadId, ...identity])}`;
      params.commitGuard?.();
      const appended = await transcript.appendMessage({
        message: { ...imported, idempotencyKey },
        // Despite its name, scan uses the transcript identity index, not a
        // transcript walk. Each source item needs one indexed lookup.
        idempotencyLookup: "scan",
        preparation: {
          prepareMessage: async (message) => {
            const wrapped = importedSessionCatalogMessage({
              catalogId: params.catalogId,
              item: {
                ...item,
                text: wrapExternalContent(
                  item.text?.trim() || "[Unsupported catalog transcript item]",
                  {
                    source: "unknown",
                    includeWarning: false,
                  },
                ),
              },
              fallbackTimestamp: fallbackTimestamp + index + 1,
            });
            return wrapped ? { ...wrapped, idempotencyKey } : message;
          },
          source: params.commitGuard,
        },
      });
      if (appended?.appended) {
        importedItems += 1;
      }
    }
  });
  return { importedItems };
}

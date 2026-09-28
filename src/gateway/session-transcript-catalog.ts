import { createHash } from "node:crypto";
import {
  parseDateFirstTimestampMs,
  timestampMsToIsoString,
} from "@openclaw/normalization-core/number-coercion";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { z } from "zod";
import type { SessionCatalogTranscriptItem } from "../../packages/gateway-protocol/src/schema/sessions-catalog.js";
import { readTranscriptSenderIdentity } from "../chat/sender-identity.js";
import { loadSessionEntryReadOnly } from "../config/sessions/session-accessor.js";
import type { SessionTranscriptReadScope } from "../config/sessions/session-accessor.sqlite-contract.js";
import { readSessionTranscriptHistoryEventPage } from "../config/sessions/session-accessor.sqlite-history-events.js";
import { SessionTranscriptColdError } from "../config/sessions/session-cold-storage-state.js";
import { resolveSessionStorePathForScope } from "../config/sessions/session-store-path.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { redactToolPayloadText } from "../logging/redact.js";
import { isAssistantTextContentType } from "./chat-display-projection.helpers.js";
import { projectChatDisplayMessages } from "./chat-display-projection.js";
import { isSuppressedControlReplyText } from "./control-reply-text.js";
import { createSessionCatalogSourceParticipantProjector } from "./session-catalog-identity.js";
import { projectSessionDisplayMessage } from "./session-display-projection.js";
import { sqliteMessageEventWithSeq } from "./session-transcript-entry-message.js";
import { deriveSessionTitle } from "./session-utils-core.js";

export type SessionTranscriptCatalogPage = {
  items: SessionCatalogTranscriptItem[];
  nextCursor?: string;
};

type CatalogReadParams = {
  agentId: string;
  sessionKey: string;
  storePath?: string;
  limit: number;
  cursor?: string;
  sourceDomain: string;
  pluginId: string;
};

const MAX_CATALOG_ITEMS = 200;
const MAX_CATALOG_TEXT_CHARS = 6000;
const MAX_CATALOG_READ_BYTES = 8 * 1024 * 1024;
const MAX_CATALOG_SCAN_MESSAGES = 1000;
const CursorSchema = z.strictObject({
  version: z.literal(1),
  scope: z.string().length(43),
  source: z.string().max(512).optional(),
  anchor: z.strictObject({
    seq: z.number().int().positive().safe(),
    eventSeq: z.number().int().nonnegative().safe(),
  }),
  before: z.number().int().nonnegative().safe(),
  skip: z.number().int().nonnegative().max(100_000),
});
type CatalogCursor = z.infer<typeof CursorSchema>;

function readCatalogHistoryPage(
  scope: SessionTranscriptReadScope,
  options: { offset: number; maxMessages: number },
) {
  const page = readSessionTranscriptHistoryEventPage(scope, {
    ...options,
    maxBytes: MAX_CATALOG_READ_BYTES,
    readOnly: true,
  });
  if (page.omittedOversized) {
    throw new Error(
      "A transcript entry is too large to share. Open the session on the source Gateway to inspect it.",
    );
  }
  return page;
}

function decodeCursor(cursor: string | undefined): CatalogCursor | undefined {
  if (cursor === undefined) {
    return undefined;
  }
  try {
    if (cursor.length > 1200 || !/^[A-Za-z0-9_-]+$/.test(cursor)) {
      throw new Error("invalid encoding");
    }
    const decoded = Buffer.from(cursor, "base64url");
    if (decoded.toString("base64url") !== cursor) {
      throw new Error("noncanonical encoding");
    }
    return CursorSchema.parse(JSON.parse(decoded.toString("utf8")));
  } catch {
    throw new Error("Invalid session transcript cursor; reload the session.");
  }
}

function boundedText(text: string): Pick<SessionCatalogTranscriptItem, "text" | "truncated"> {
  const redacted = redactToolPayloadText(text);
  return redacted.length > MAX_CATALOG_TEXT_CHARS
    ? { text: truncateUtf16Safe(redacted, MAX_CATALOG_TEXT_CHARS), truncated: true }
    : { text: redacted };
}

function projectContentItem(
  role: unknown,
  value: unknown,
): SessionCatalogTranscriptItem | undefined {
  if (role !== "user" && role !== "assistant") {
    return undefined;
  }
  const block = asOptionalRecord(value);
  if (typeof value !== "string" && !isAssistantTextContentType(block?.type)) {
    return undefined;
  }
  const text = typeof value === "string" ? value : block?.text;
  if (
    typeof text !== "string" ||
    !text.trim() ||
    (role === "assistant" && isSuppressedControlReplyText(text))
  ) {
    return undefined;
  }
  return { type: role === "user" ? "userMessage" : "agentMessage", ...boundedText(text) };
}

function projectMessageItems(
  message: Record<string, unknown>,
  params: CatalogReadParams,
  projectSender: ReturnType<typeof createSessionCatalogSourceParticipantProjector>,
): SessionCatalogTranscriptItem[] {
  const metadata = asOptionalRecord(message["__openclaw"]);
  const identity =
    message.role === "user" ? readTranscriptSenderIdentity(metadata?.senderIdentity) : undefined;
  const senderName = metadata?.senderName ?? message.senderLabel;
  const sender = identity
    ? projectSender({
        ...params,
        identity,
        label: typeof senderName === "string" ? senderName : undefined,
      })
    : undefined;
  const timestampText = timestampMsToIsoString(
    parseDateFirstTimestampMs(message.timestamp ?? metadata?.recordTimestampMs),
  );
  const content = Array.isArray(message.content)
    ? message.content
    : [message.content ?? message.text];
  return content
    .flatMap((block, index) => {
      const item = projectContentItem(message.role, block);
      if (!item) {
        return [];
      }
      return [
        Object.assign(item, {
          ...(metadata?.truncated === true ? { truncated: true } : {}),
          ...(typeof metadata?.id === "string" ? { id: `${metadata.id}:${index}` } : {}),
          ...(timestampText ? { timestamp: timestampText } : {}),
          ...(typeof message.model === "string"
            ? { model: redactToolPayloadText(message.model).slice(0, 200) }
            : {}),
          ...(sender ? { sender } : {}),
        }),
      ];
    })
    .toReversed();
}

/** Reads conversation text without joining the source Gateway's writer lifecycle. */
export async function readSessionTranscriptCatalogPage(
  params: CatalogReadParams,
): Promise<SessionTranscriptCatalogPage> {
  const cursor = decodeCursor(params.cursor);
  if (!Number.isSafeInteger(params.limit) || params.limit < 1 || params.limit > MAX_CATALOG_ITEMS) {
    throw new Error(`Session transcript limit must be an integer from 1 to ${MAX_CATALOG_ITEMS}.`);
  }
  const storePath = resolveSessionStorePathForScope(params);
  const entry = loadSessionEntryReadOnly({ ...params, storePath });
  if (!entry) {
    throw new Error("Session not found; refresh the session catalog.");
  }
  const scope = {
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    sessionId: entry.sessionId,
    sessionEntry: entry,
    storePath,
  };
  const scopeHash = createHash("sha256")
    // Item offsets from the earlier tool-inclusive projection cannot resume this view.
    .update(
      JSON.stringify([
        "conversation",
        params.agentId,
        params.sessionKey,
        entry.sessionId,
        storePath,
      ]),
    )
    .digest("base64url");
  const snapshot = readCatalogHistoryPage(scope, {
    offset: 0,
    maxMessages: 1,
  });
  if (
    cursor &&
    (cursor.scope !== scopeHash ||
      cursor.source !== snapshot.displaySource ||
      cursor.anchor.seq > snapshot.totalMessages ||
      cursor.before > snapshot.totalMessages)
  ) {
    throw new Error(
      "Session transcript cursor no longer matches this session; reload the session.",
    );
  }
  const tail = snapshot.events.at(-1);
  const anchor = cursor?.anchor ?? (tail ? { seq: tail.seq, eventSeq: tail.eventSeq } : undefined);
  // Appends retain this active-path anchor; leaf rewinds can preserve the rewrite
  // generation, so source hashes alone cannot fence a cursor onto its original branch.
  if (cursor) {
    const anchoredPage = readCatalogHistoryPage(scope, {
      offset: snapshot.totalMessages - cursor.anchor.seq,
      maxMessages: 1,
    });
    if (anchoredPage.events[0]?.eventSeq !== cursor.anchor.eventSeq) {
      throw new Error(
        "Session transcript cursor no longer matches this session; reload the session.",
      );
    }
  }
  const limit = params.limit;
  let before = cursor?.before ?? snapshot.totalMessages;
  let skip = cursor?.skip ?? 0;
  let scanned = 0;
  const items: SessionCatalogTranscriptItem[] = [];
  const projectSender = createSessionCatalogSourceParticipantProjector();
  while (before > 0 && items.length < limit && scanned < MAX_CATALOG_SCAN_MESSAGES) {
    const page = readCatalogHistoryPage(scope, {
      offset: snapshot.totalMessages - before,
      maxMessages: Math.min(before, limit + 1),
    });
    // A source append preserves positions; a rewrite rotates displaySource and invalidates cursors.
    if (
      page.displaySource !== snapshot.displaySource ||
      page.activeLeafEntryId !== snapshot.activeLeafEntryId ||
      page.totalMessages !== snapshot.totalMessages
    ) {
      throw new Error("Session transcript changed during this read; retry the page.");
    }
    const projected = projectChatDisplayMessages(page.events.map(sqliteMessageEventWithSeq), {
      maxChars: MAX_CATALOG_TEXT_CHARS,
    });
    const bySequence = new Map<unknown, SessionCatalogTranscriptItem[]>();
    for (const message of projected.toReversed()) {
      const seq = asOptionalRecord(message["__openclaw"])?.seq;
      const previous = bySequence.get(seq) ?? [];
      previous.push(...projectMessageItems(message, params, projectSender));
      bySequence.set(seq, previous);
    }
    for (const event of page.events.toReversed()) {
      const messageItems = bySequence.get(event.seq) ?? [];
      if (skip > messageItems.length) {
        throw new Error("Invalid session transcript cursor; reload the session.");
      }
      const selected = messageItems.slice(skip, skip + limit - items.length);
      items.push(...selected);
      skip += selected.length;
      before = event.seq;
      if (skip === messageItems.length) {
        before -= 1;
        skip = 0;
      }
      scanned += 1;
      if (items.length === limit || scanned === MAX_CATALOG_SCAN_MESSAGES) {
        break;
      }
    }
    if (page.events.length === 0) {
      break;
    }
  }
  const nextCursor =
    before > 0 && anchor
      ? Buffer.from(
          JSON.stringify({
            version: 1,
            scope: scopeHash,
            source: snapshot.displaySource,
            anchor,
            before,
            skip,
          } satisfies CatalogCursor),
        ).toString("base64url")
      : undefined;
  return { items, ...(nextCursor ? { nextCursor } : {}) };
}

/** Matches local session-title precedence, with a bounded read-only first-message probe. */
export function readSessionTranscriptCatalogTitle(params: {
  agentId: string;
  sessionKey: string;
  storePath?: string;
  entry: SessionEntry;
}): string | undefined {
  const title = deriveSessionTitle(params.entry);
  if (title) {
    return boundedText(title).text;
  }
  const scope = {
    ...params,
    storePath: resolveSessionStorePathForScope(params),
    sessionId: params.entry.sessionId,
    sessionEntry: params.entry,
  };
  try {
    const snapshot = readCatalogHistoryPage(scope, { offset: 0, maxMessages: 0 });
    const page = readSessionTranscriptHistoryEventPage(scope, {
      offset: Math.max(0, snapshot.totalMessages - 100),
      maxMessages: 100,
      maxBytes: MAX_CATALOG_READ_BYTES,
      readOnly: true,
    });
    // A clipped prefix cannot establish the first user message's title.
    if (page.olderOffset !== undefined || page.omittedOversized) {
      return undefined;
    }
    for (const event of page.events) {
      const message = projectSessionDisplayMessage(sqliteMessageEventWithSeq(event));
      if (message?.role === "user") {
        const derived = deriveSessionTitle(params.entry, message.text);
        return derived ? boundedText(derived).text : undefined;
      }
    }
  } catch (error) {
    if (!(error instanceof SessionTranscriptColdError)) {
      throw error;
    }
  }
  return undefined;
}

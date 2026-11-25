import { createHash } from "node:crypto";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeBoundedOptionalString } from "@openclaw/normalization-core/string-coerce";
import { Value } from "typebox/value";
import {
  SessionCatalogSourceProfileRelationSchema,
  type SessionCatalogSourceProfileRelation,
} from "../../packages/gateway-protocol/src/schema/session-catalog-query.js";
import type { SessionCatalogTranscriptItem } from "../../packages/gateway-protocol/src/schema/sessions-catalog.js";
import { truncateUtf8Prefix } from "../utils/utf8-truncate.js";

/** Keep a host's publication owned until its callback finishes, even after a fail-soft list. */
export function publishSessionCatalogHost<T>(
  params: {
    onHost?: (host: T) => void;
    waitUntil?: (completion: Promise<void>) => void;
  },
  pendingHost: Promise<T>,
): void {
  const { onHost, waitUntil } = params;
  const published = pendingHost.then((host) => onHost?.(host));
  // Observe rejection before registration: a closed owner may reject this handoff synchronously.
  void published.catch(() => undefined);
  waitUntil?.(published);
}

const DEFAULT_PAGE_LIMIT = 20;
const MAX_PAGE_LIMIT = 100;
const MAX_CURSOR_LENGTH = 128;
const MAX_TRANSCRIPT_ITEM_BYTES = 512 * 1024;
const MAX_TRANSCRIPT_PAGE_BYTES = 20 * 1024 * 1024;

type SessionCatalogParameterMessages = {
  listNotObject: string;
  unknownListParameter: (key: string) => string;
  invalidSearchTerm: string;
  readNotObject: string;
  unknownReadParameter: (key: string) => string;
  invalidThreadId: string;
};

type SessionCatalogListParams = {
  profileRelation?: SessionCatalogSourceProfileRelation;
  searchTerm?: string;
  limit: number;
  cursor?: string;
};

type SessionCatalogReadParams = {
  profileRelation?: SessionCatalogSourceProfileRelation;
  threadId: string;
  limit: number;
  cursor?: string;
};

function boundedSessionCatalogLimit(value: unknown, fallback = DEFAULT_PAGE_LIMIT): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > MAX_PAGE_LIMIT) {
    throw new Error(`limit must be an integer between 1 and ${String(MAX_PAGE_LIMIT)}`);
  }
  return Number(value);
}

function cursorScope(query: SessionCatalogSourceProfileRelation): string {
  return createHash("sha256")
    .update(JSON.stringify([query.relationship, query.target.type, query.target.id]))
    .digest("base64url");
}

function parseProfileRelation(value: unknown): SessionCatalogSourceProfileRelation | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Value.Check(SessionCatalogSourceProfileRelationSchema, value)) {
    throw new Error("profileRelation is invalid");
  }
  return {
    relationship: value.relationship,
    target: { type: value.target.type, id: value.target.id },
  };
}

function encodeSessionCatalogCursor(
  offset: number,
  query?: SessionCatalogSourceProfileRelation,
): string {
  return Buffer.from(
    JSON.stringify({ offset, ...(query ? { scope: cursorScope(query) } : {}) }),
    "utf8",
  ).toString("base64url");
}

function optionalSessionCatalogCursor(
  value: unknown,
  maxLength = MAX_CURSOR_LENGTH,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    throw new Error("cursor is invalid");
  }
  return value;
}

function parseSessionCatalogListParams(
  value: unknown,
  options: {
    searchMaxLength: number;
    supportsProfileRelation?: boolean;
    messages: SessionCatalogParameterMessages;
  },
): SessionCatalogListParams {
  if (value === undefined || value === null) {
    return { limit: DEFAULT_PAGE_LIMIT };
  }
  if (!isRecord(value)) {
    throw new Error(options.messages.listNotObject);
  }
  const unknown = Object.keys(value).find(
    (key) =>
      ![
        "searchTerm",
        "limit",
        "cursor",
        ...(options.supportsProfileRelation ? ["profileRelation"] : []),
      ].includes(key),
  );
  if (unknown) {
    throw new Error(options.messages.unknownListParameter(unknown));
  }
  const searchTerm = normalizeBoundedOptionalString(value.searchTerm, options.searchMaxLength);
  if (value.searchTerm !== undefined && !searchTerm) {
    throw new Error(options.messages.invalidSearchTerm);
  }
  const cursor = optionalSessionCatalogCursor(value.cursor);
  return {
    ...(value.profileRelation !== undefined
      ? { profileRelation: parseProfileRelation(value.profileRelation) }
      : {}),
    limit: boundedSessionCatalogLimit(value.limit),
    ...(searchTerm ? { searchTerm } : {}),
    ...(cursor ? { cursor } : {}),
  };
}

function parseSessionCatalogReadParams(
  value: unknown,
  options: {
    threadIdMaxLength: number;
    supportsProfileRelation?: boolean;
    threadIdPattern: RegExp;
    cursorMaxLength?: number;
    messages: SessionCatalogParameterMessages;
  },
): SessionCatalogReadParams {
  if (!isRecord(value)) {
    throw new Error(options.messages.readNotObject);
  }
  const unknown = Object.keys(value).find(
    (key) =>
      ![
        "threadId",
        "limit",
        "cursor",
        ...(options.supportsProfileRelation ? ["profileRelation"] : []),
      ].includes(key),
  );
  if (unknown) {
    throw new Error(options.messages.unknownReadParameter(unknown));
  }
  const threadId = normalizeBoundedOptionalString(value.threadId, options.threadIdMaxLength);
  if (!threadId || !options.threadIdPattern.test(threadId)) {
    throw new Error(options.messages.invalidThreadId);
  }
  const cursor = optionalSessionCatalogCursor(value.cursor, options.cursorMaxLength);
  return {
    threadId,
    ...(value.profileRelation !== undefined
      ? { profileRelation: parseProfileRelation(value.profileRelation) }
      : {}),
    limit: boundedSessionCatalogLimit(value.limit),
    ...(cursor ? { cursor } : {}),
  };
}

function decodeSessionCatalogCursor(
  value: unknown,
  query?: SessionCatalogSourceProfileRelation,
): number {
  const cursor = optionalSessionCatalogCursor(value);
  if (cursor === undefined) {
    return 0;
  }
  try {
    const bytes = Buffer.from(cursor, "base64url");
    if (bytes.toString("base64url") !== cursor) {
      throw new Error("non-canonical base64url");
    }
    const parsed = JSON.parse(bytes.toString("utf8")) as unknown;
    if (!isRecord(parsed) || !Number.isSafeInteger(parsed.offset) || Number(parsed.offset) < 0) {
      throw new Error("invalid offset");
    }
    const offset = Number(parsed.offset);
    if (encodeSessionCatalogCursor(offset, query) !== cursor) {
      throw new Error("non-canonical cursor payload");
    }
    return offset;
  } catch (error) {
    throw new Error("cursor is invalid", { cause: error });
  }
}

function encodeScopedCursor(cursor: string, query?: SessionCatalogSourceProfileRelation): string {
  return query
    ? Buffer.from(JSON.stringify({ cursor, scope: cursorScope(query) }), "utf8").toString(
        "base64url",
      )
    : cursor;
}

function decodeScopedCursor(
  cursor: string | undefined,
  query?: SessionCatalogSourceProfileRelation,
): string | undefined {
  if (!cursor || !query) {
    return cursor;
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (
      !isRecord(parsed) ||
      typeof parsed.cursor !== "string" ||
      encodeScopedCursor(parsed.cursor, query) !== cursor
    ) {
      throw new Error("query mismatch");
    }
    return parsed.cursor;
  } catch (error) {
    throw new Error("cursor does not belong to this relationship query", { cause: error });
  }
}

function isExactSessionCatalogCursor(
  value: unknown,
  query?: SessionCatalogSourceProfileRelation,
): value is string {
  if (typeof value !== "string") {
    return false;
  }
  try {
    decodeSessionCatalogCursor(value, query);
    return true;
  } catch {
    return false;
  }
}

function truncateUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) {
    return text;
  }
  return `${truncateUtf8Prefix(text, maxBytes - 3)}…`;
}

/** Page chronological source items newest-first, bounding per-item and per-page byte budgets. */
function boundSessionCatalogTranscriptPage(
  items: SessionCatalogTranscriptItem[],
  limit: number,
  offset: number,
): { items: SessionCatalogTranscriptItem[]; nextCursor?: string } {
  const end = Math.max(0, items.length - offset);
  const start = Math.max(0, end - limit);
  const page: SessionCatalogTranscriptItem[] = [];
  let pageBytes = 2;
  for (let index = end - 1; index >= start; index -= 1) {
    const item = items[index];
    if (!item) {
      continue;
    }
    const bounded: SessionCatalogTranscriptItem = {
      ...item,
      text: truncateUtf8(item.text ?? "", MAX_TRANSCRIPT_ITEM_BYTES),
    };
    const itemBytes = Buffer.byteLength(JSON.stringify(bounded), "utf8") + 1;
    if (page.length > 0 && pageBytes + itemBytes > MAX_TRANSCRIPT_PAGE_BYTES) {
      break;
    }
    page.push(bounded);
    pageBytes += itemBytes;
  }
  const consumed = offset + page.length;
  return {
    items: page,
    ...(consumed < items.length ? { nextCursor: encodeSessionCatalogCursor(consumed) } : {}),
  };
}

/** Canonical bounded parameter, base64url cursor, and UTF-8 transcript paging contract. */
export const sessionCatalogPaging = {
  encodeScopedCursor,
  decodeScopedCursor,
  boundedLimit: boundedSessionCatalogLimit,
  encodeCursor: encodeSessionCatalogCursor,
  optionalCursor: optionalSessionCatalogCursor,
  parseListParams: parseSessionCatalogListParams,
  parseReadParams: parseSessionCatalogReadParams,
  decodeCursor: decodeSessionCatalogCursor,
  isExactCursor: isExactSessionCatalogCursor,
  boundTranscriptPage: boundSessionCatalogTranscriptPage,
} as const;

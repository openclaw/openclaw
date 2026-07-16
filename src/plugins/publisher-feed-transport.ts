import { readResponseWithLimit } from "../infra/http-body.js";
import { fetchWithSsrFGuard } from "../infra/net/fetch-guard.js";
import type { TrustedFeedSigningKey } from "./official-external-plugin-catalog-envelope.js";
import {
  PUBLISHER_FEED_CHANGES_PAYLOAD_TYPE,
  PUBLISHER_FEED_QUERY_PAYLOAD_TYPE,
  verifyPublisherFeedProjection,
  type PublisherFeedChange,
  type PublisherFeedChangePage,
  type PublisherFeedEntry,
  type PublisherFeedQuery,
  type PublisherFeedQueryPage,
  type PublisherFeedResetRequired,
} from "./publisher-feed-projections.js";

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

type PublisherFeedVerification = {
  trustedKeys: readonly TrustedFeedSigningKey[];
  threshold?: number;
};

type PublisherFeedTransportOptions = {
  baseUrl: string;
  publisherId: string;
  verification: PublisherFeedVerification;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  chunkTimeoutMs?: number;
  maxPages?: number;
  now?: () => Date;
};

export type PublisherFeedQueryResult = {
  feedId: string;
  sequence: number;
  generatedAt: string;
  expiresAt: string;
  query: PublisherFeedQuery;
  entries: readonly PublisherFeedEntry[];
};

export type PublisherFeedChangesResult =
  | {
      status: "complete";
      feedId: string;
      fromSequence: number;
      toSequence: number;
      generatedAt: string;
      expiresAt: string;
      changes: readonly PublisherFeedChange[];
    }
  | { status: "reset-required"; reset: PublisherFeedResetRequired };

export type PublisherFeedState = {
  feedId: string;
  sequence: number;
  publisherId: string;
  handle: string | null;
  displayName: string;
  entries: readonly PublisherFeedEntry[];
};

export type PublisherFeedApplyResult =
  | { status: "applied"; state: PublisherFeedState }
  | { status: "reset-required"; reset: PublisherFeedResetRequired };

const PUBLISHER_FEED_PAGE_MAX_BYTES = 1024 * 1024;
const PUBLISHER_FEED_DEFAULT_TIMEOUT_MS = 5_000;
const PUBLISHER_FEED_DEFAULT_MAX_PAGES = 50;
const PUBLISHER_FEED_MAX_MAX_PAGES = 100;
const PUBLISHER_FEED_QUERY_MAX_LIMIT = 200;
const PUBLISHER_FEED_CHANGE_MAX_LIMIT = 500;
const PUBLISHER_FEED_CONTENT_TYPE = "application/vnd.dsse+json";

function normalizeBaseUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error("publisher feed base URL is invalid");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "/" && url.pathname !== "")
  ) {
    throw new Error("publisher feed base URL must be an HTTPS origin without credentials");
  }
  return new URL(url.origin);
}

function normalizePublisherId(raw: string): string {
  const publisherId = raw.trim();
  if (!publisherId || new TextEncoder().encode(publisherId).length > 200) {
    throw new Error("publisher feed publisher id is invalid");
  }
  return publisherId;
}

function normalizeLimit(value: number | undefined, fallback: number, maximum: number): number {
  const limit = value ?? fallback;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > maximum) {
    throw new Error(`publisher feed page limit must be between 1 and ${maximum}`);
  }
  return limit;
}

function normalizeMaxPages(value: number | undefined): number {
  const maxPages = value ?? PUBLISHER_FEED_DEFAULT_MAX_PAGES;
  if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > PUBLISHER_FEED_MAX_MAX_PAGES) {
    throw new Error(
      `publisher feed max pages must be between 1 and ${PUBLISHER_FEED_MAX_MAX_PAGES}`,
    );
  }
  return maxPages;
}

function normalizeQueryTextWhitespace(value: string): string {
  let result = "";
  let pendingSpace = false;
  for (const character of value.normalize("NFC")) {
    const codePoint = character.codePointAt(0) ?? 0;
    if ((codePoint >= 0x09 && codePoint <= 0x0d) || codePoint === 0x20) {
      pendingSpace = result.length > 0;
      continue;
    }
    if (pendingSpace) {
      result += " ";
    }
    result += character;
    pendingSpace = false;
  }
  return result;
}

function normalizeQuery(query: PublisherFeedQuery): PublisherFeedQuery {
  const normalized: PublisherFeedQuery = {};
  if (query.text !== undefined) {
    const text = normalizeQueryTextWhitespace(query.text);
    if (!text || new TextEncoder().encode(text).length > 256) {
      throw new Error("publisher feed query text must be between 1 and 256 UTF-8 bytes");
    }
    normalized.text = text;
  }
  if (query.kinds !== undefined) {
    const kinds = [...new Set(query.kinds)].toSorted();
    if (kinds.length === 0 || kinds.some((kind) => kind !== "skill" && kind !== "plugin")) {
      throw new Error("publisher feed query kinds are invalid");
    }
    normalized.kinds = kinds;
  }
  if (normalized.text === undefined && normalized.kinds === undefined) {
    throw new Error("publisher feed query must include text or kinds");
  }
  return normalized;
}

function sameQuery(left: PublisherFeedQuery, right: PublisherFeedQuery): boolean {
  if (left.text !== right.text) {
    return false;
  }
  const leftKinds = left.kinds ?? [];
  const rightKinds = right.kinds ?? [];
  return (
    leftKinds.length === rightKinds.length &&
    leftKinds.every((kind, index) => kind === rightKinds[index])
  );
}

function projectionPath(publisherId: string, operation: "query" | "changes"): string {
  return `/api/v1/publishers/${encodeURIComponent(publisherId)}/feed/${operation}`;
}

function initialQueryUrl(
  baseUrl: URL,
  publisherId: string,
  query: PublisherFeedQuery,
  limit: number,
) {
  const url = new URL(projectionPath(publisherId, "query"), baseUrl);
  if (query.text !== undefined) {
    url.searchParams.set("q", query.text);
  }
  for (const kind of query.kinds ?? []) {
    url.searchParams.append("kind", kind);
  }
  url.searchParams.set("limit", String(limit));
  return url;
}

function initialChangesUrl(baseUrl: URL, publisherId: string, fromSequence: number, limit: number) {
  const url = new URL(projectionPath(publisherId, "changes"), baseUrl);
  url.searchParams.set("fromSequence", String(fromSequence));
  url.searchParams.set("limit", String(limit));
  return url;
}

function continuationUrl(
  baseUrl: URL,
  publisherId: string,
  operation: "query" | "changes",
  cursor: string,
) {
  const url = new URL(projectionPath(publisherId, operation), baseUrl);
  url.searchParams.set("cursor", cursor);
  return url;
}

function assertContentLength(response: Response): void {
  const raw = response.headers.get("content-length");
  if (raw === null) {
    return;
  }
  if (!/^\d+$/u.test(raw)) {
    throw new Error("publisher feed response has invalid content-length");
  }
  const length = Number(raw);
  if (!Number.isSafeInteger(length) || length > PUBLISHER_FEED_PAGE_MAX_BYTES) {
    throw new Error(`publisher feed response exceeds ${PUBLISHER_FEED_PAGE_MAX_BYTES} bytes`);
  }
}

async function readProjectionEnvelope(params: {
  url: URL;
  operation: "query" | "changes";
  verification: PublisherFeedVerification;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  chunkTimeoutMs?: number;
}) {
  const guarded = await fetchWithSsrFGuard({
    url: params.url.href,
    fetchImpl: params.fetchImpl,
    init: { method: "GET", headers: { accept: PUBLISHER_FEED_CONTENT_TYPE } },
    requireHttps: true,
    maxRedirects: 2,
    timeoutMs: params.timeoutMs ?? PUBLISHER_FEED_DEFAULT_TIMEOUT_MS,
    policy: { hostnameAllowlist: [params.url.hostname] },
    auditContext: "publisher-feed-projection",
  });
  try {
    if (guarded.finalUrl !== params.url.href) {
      throw new Error("publisher feed projection redirected away from the requested page");
    }
    const allowedStatuses = params.operation === "changes" ? [200, 409] : [200];
    if (!allowedStatuses.includes(guarded.response.status)) {
      throw new Error(`publisher feed projection returned HTTP ${guarded.response.status}`);
    }
    const contentType = guarded.response.headers.get("content-type")?.split(";", 1)[0]?.trim();
    if (contentType !== PUBLISHER_FEED_CONTENT_TYPE) {
      throw new Error("publisher feed projection returned an unsupported content type");
    }
    assertContentLength(guarded.response);
    const body = await readResponseWithLimit(guarded.response, PUBLISHER_FEED_PAGE_MAX_BYTES, {
      chunkTimeoutMs: params.chunkTimeoutMs ?? PUBLISHER_FEED_DEFAULT_TIMEOUT_MS,
      onOverflow: ({ maxBytes }) => new Error(`publisher feed response exceeds ${maxBytes} bytes`),
      onIdleTimeout: ({ chunkTimeoutMs }) =>
        new Error(`publisher feed response timed out after ${chunkTimeoutMs}ms`),
    });
    let envelope: unknown;
    try {
      envelope = JSON.parse(body.toString("utf8"));
    } catch {
      throw new Error("publisher feed projection envelope is not valid JSON");
    }
    const verified = verifyPublisherFeedProjection(envelope, {
      payloadType:
        params.operation === "query"
          ? PUBLISHER_FEED_QUERY_PAYLOAD_TYPE
          : PUBLISHER_FEED_CHANGES_PAYLOAD_TYPE,
      ...params.verification,
    });
    return { status: guarded.response.status, payload: verified.payload };
  } finally {
    if (!guarded.response.bodyUsed) {
      await guarded.response.body?.cancel().catch(() => undefined);
    }
    await guarded.release();
  }
}

function assertNotExpired(expiresAt: string, now: () => Date): void {
  if (Date.parse(expiresAt) <= now().getTime()) {
    throw new Error("publisher feed projection expired during traversal");
  }
}

function assertUniqueEntries(entries: readonly PublisherFeedEntry[]): void {
  const identities = new Set<string>();
  for (const entry of entries) {
    const identity = `${entry.kind}\0${entry.id}`;
    if (identities.has(identity)) {
      throw new Error("publisher feed query returned duplicate entries");
    }
    identities.add(identity);
  }
}

function entryIdentity(entry: Pick<PublisherFeedEntry, "kind" | "id">): string {
  return `${entry.kind}\0${entry.id}`;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareEntries(left: PublisherFeedEntry, right: PublisherFeedEntry): number {
  return (
    right.updatedAt - left.updatedAt ||
    compareCodeUnits(left.kind, right.kind) ||
    compareCodeUnits(left.id, right.id)
  );
}

export function applyPublisherFeedChanges(
  current: PublisherFeedState,
  result: PublisherFeedChangesResult,
): PublisherFeedApplyResult {
  if (result.status === "reset-required") {
    if (
      result.reset.feedId !== current.feedId ||
      result.reset.fromSequence !== current.sequence ||
      current.feedId !== `clawhub.publisher.${current.publisherId}`
    ) {
      throw new Error("publisher feed reset does not continue the current state");
    }
    return result;
  }
  if (
    result.feedId !== current.feedId ||
    result.fromSequence !== current.sequence ||
    current.feedId !== `clawhub.publisher.${current.publisherId}`
  ) {
    throw new Error("publisher feed changes do not continue the current state");
  }
  const entries = new Map(current.entries.map((entry) => [entryIdentity(entry), { ...entry }]));
  if (entries.size !== current.entries.length) {
    throw new Error("current publisher feed state contains duplicate entries");
  }
  let publisherId = current.publisherId;
  let handle = current.handle;
  let displayName = current.displayName;
  let previousSequence = result.fromSequence;
  const seenSequences = new Set<number>();
  for (const change of result.changes) {
    if (
      !Number.isSafeInteger(change.sequence) ||
      change.sequence <= result.fromSequence ||
      change.sequence < previousSequence ||
      change.sequence > result.toSequence
    ) {
      throw new Error("publisher feed changes are not ordered within the signed range");
    }
    previousSequence = change.sequence;
    seenSequences.add(change.sequence);
    if (change.operation === "upsert") {
      entries.set(entryIdentity(change.entry), { ...change.entry });
    } else if (change.operation === "remove") {
      entries.delete(`${change.entryKind}\0${change.entryId}`);
    } else {
      if (
        change.metadata.publisherId !== current.publisherId ||
        result.feedId !== `clawhub.publisher.${change.metadata.publisherId}`
      ) {
        throw new Error("publisher feed metadata changed stable publisher identity");
      }
      publisherId = change.metadata.publisherId;
      handle = change.metadata.handle;
      displayName = change.metadata.displayName;
    }
  }
  const expectedSequenceCount = result.toSequence - result.fromSequence;
  if (seenSequences.size !== expectedSequenceCount) {
    throw new Error("publisher feed changes omitted a revision from the signed range");
  }
  return {
    status: "applied",
    state: {
      feedId: current.feedId,
      sequence: result.toSequence,
      publisherId,
      handle,
      displayName,
      entries: [...entries.values()].toSorted(compareEntries),
    },
  };
}

export async function fetchPublisherFeedQuery(
  params: PublisherFeedTransportOptions & { query: PublisherFeedQuery; limit?: number },
): Promise<PublisherFeedQueryResult> {
  const baseUrl = normalizeBaseUrl(params.baseUrl);
  const publisherId = normalizePublisherId(params.publisherId);
  const expectedFeedId = `clawhub.publisher.${publisherId}`;
  const query = normalizeQuery(params.query);
  const limit = normalizeLimit(params.limit, 50, PUBLISHER_FEED_QUERY_MAX_LIMIT);
  const maxPages = normalizeMaxPages(params.maxPages);
  const now = params.now ?? (() => new Date());
  const entries: PublisherFeedEntry[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | null = null;
  let first: PublisherFeedQueryPage | null = null;

  for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
    const url =
      cursor === null
        ? initialQueryUrl(baseUrl, publisherId, query, limit)
        : continuationUrl(baseUrl, publisherId, "query", cursor);
    const response = await readProjectionEnvelope({
      url,
      operation: "query",
      verification: params.verification,
      fetchImpl: params.fetchImpl,
      timeoutMs: params.timeoutMs,
      chunkTimeoutMs: params.chunkTimeoutMs,
    });
    const page = response.payload as PublisherFeedQueryPage;
    if (
      page.feedId !== expectedFeedId ||
      page.pageIndex !== pageIndex ||
      page.startIndex !== entries.length ||
      page.requestCursor !== cursor ||
      !sameQuery(page.query, query)
    ) {
      throw new Error("publisher feed query page continuity check failed");
    }
    assertNotExpired(page.expiresAt, now);
    if (!first) {
      first = page;
    } else if (
      page.sequence !== first.sequence ||
      page.generatedAt !== first.generatedAt ||
      page.expiresAt !== first.expiresAt ||
      page.resultCount !== first.resultCount
    ) {
      throw new Error("publisher feed query revision changed during traversal");
    }
    entries.push(...page.entries);
    cursor = page.nextCursor;
    if (cursor === null) {
      if (entries.length !== page.resultCount) {
        throw new Error("publisher feed query terminated before its signed result count");
      }
      assertUniqueEntries(entries);
      return {
        feedId: page.feedId,
        sequence: page.sequence,
        generatedAt: page.generatedAt,
        expiresAt: page.expiresAt,
        query: page.query,
        entries,
      };
    }
    if (seenCursors.has(cursor)) {
      throw new Error("publisher feed query cursor repeated during traversal");
    }
    seenCursors.add(cursor);
  }
  throw new Error(`publisher feed query exceeded ${maxPages} pages`);
}

export async function fetchPublisherFeedChanges(
  params: PublisherFeedTransportOptions & { fromSequence: number; limit?: number },
): Promise<PublisherFeedChangesResult> {
  const baseUrl = normalizeBaseUrl(params.baseUrl);
  const publisherId = normalizePublisherId(params.publisherId);
  const expectedFeedId = `clawhub.publisher.${publisherId}`;
  if (!Number.isSafeInteger(params.fromSequence) || params.fromSequence < 0) {
    throw new Error("publisher feed from sequence is invalid");
  }
  const limit = normalizeLimit(params.limit, 100, PUBLISHER_FEED_CHANGE_MAX_LIMIT);
  const maxPages = normalizeMaxPages(params.maxPages);
  const now = params.now ?? (() => new Date());
  const changes: PublisherFeedChange[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | null = null;
  let first: PublisherFeedChangePage | null = null;

  for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
    const url =
      cursor === null
        ? initialChangesUrl(baseUrl, publisherId, params.fromSequence, limit)
        : continuationUrl(baseUrl, publisherId, "changes", cursor);
    const response = await readProjectionEnvelope({
      url,
      operation: "changes",
      verification: params.verification,
      fetchImpl: params.fetchImpl,
      timeoutMs: params.timeoutMs,
      chunkTimeoutMs: params.chunkTimeoutMs,
    });
    if (response.status === 409) {
      const reset = response.payload as PublisherFeedResetRequired;
      const expectedSnapshotUrl = new URL(
        `/api/v1/publishers/${encodeURIComponent(publisherId)}/feed`,
        baseUrl,
      );
      if (
        pageIndex !== 0 ||
        !reset.resetRequired ||
        reset.feedId !== expectedFeedId ||
        reset.fromSequence !== params.fromSequence ||
        new URL(reset.snapshotUrl).href !== expectedSnapshotUrl.href
      ) {
        throw new Error("publisher feed reset instruction is invalid");
      }
      assertNotExpired(reset.expiresAt, now);
      return { status: "reset-required", reset };
    }
    if ((response.payload as PublisherFeedResetRequired).resetRequired) {
      throw new Error("publisher feed reset instruction used an invalid HTTP status");
    }
    const page = response.payload as PublisherFeedChangePage;
    if (
      page.feedId !== expectedFeedId ||
      page.fromSequence !== params.fromSequence ||
      page.pageIndex !== pageIndex ||
      page.startIndex !== changes.length ||
      page.requestCursor !== cursor
    ) {
      throw new Error("publisher feed change page continuity check failed");
    }
    assertNotExpired(page.expiresAt, now);
    if (!first) {
      first = page;
    } else if (
      page.toSequence !== first.toSequence ||
      page.generatedAt !== first.generatedAt ||
      page.expiresAt !== first.expiresAt ||
      page.changeCount !== first.changeCount
    ) {
      throw new Error("publisher feed change range changed during traversal");
    }
    changes.push(...page.changes);
    cursor = page.nextCursor;
    if (cursor === null) {
      if (changes.length !== page.changeCount) {
        throw new Error("publisher feed changes terminated before their signed change count");
      }
      return {
        status: "complete",
        feedId: page.feedId,
        fromSequence: page.fromSequence,
        toSequence: page.toSequence,
        generatedAt: page.generatedAt,
        expiresAt: page.expiresAt,
        changes,
      };
    }
    if (seenCursors.has(cursor)) {
      throw new Error("publisher feed change cursor repeated during traversal");
    }
    seenCursors.add(cursor);
  }
  throw new Error(`publisher feed changes exceeded ${maxPages} pages`);
}

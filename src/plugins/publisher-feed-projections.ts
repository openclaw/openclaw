import { isRecord } from "../utils.js";
import {
  verifySignedFeedEnvelopePayload,
  type TrustedFeedSigningKey,
} from "./official-external-plugin-catalog-envelope.js";

export const PUBLISHER_FEED_QUERY_PAYLOAD_TYPE = "openclaw.clawhub-publisher-feed-query-results.v1";
export const PUBLISHER_FEED_CHANGES_PAYLOAD_TYPE = "openclaw.clawhub-publisher-feed-changes.v1";
export const PUBLISHER_FEED_SNAPSHOT_PAYLOAD_TYPE = "openclaw.clawhub-publisher-feed-snapshot.v1";

export type PublisherFeedEntry = {
  kind: "skill" | "plugin";
  id: string;
  name: string;
  displayName: string;
  summary: string | null;
  url: string;
  updatedAt: number;
};

export type PublisherFeedQuery = {
  text?: string;
  kinds?: readonly ("skill" | "plugin")[];
};

export type PublisherFeedChange =
  | { sequence: number; operation: "upsert"; entry: PublisherFeedEntry }
  | {
      sequence: number;
      operation: "remove";
      entryId: string;
      entryKind: "skill" | "plugin";
    }
  | {
      sequence: number;
      operation: "metadata";
      metadata: { publisherId: string; handle: string | null; displayName: string };
    };

export type PublisherFeedQueryPage = {
  schemaVersion: 1;
  feedId: string;
  sequence: number;
  generatedAt: string;
  expiresAt: string;
  query: PublisherFeedQuery;
  requestCursor: string | null;
  pageIndex: number;
  startIndex: number;
  resultCount: number;
  entries: readonly PublisherFeedEntry[];
  nextCursor: string | null;
};

export type PublisherFeedChangePage = {
  schemaVersion: 1;
  feedId: string;
  fromSequence: number;
  toSequence: number;
  generatedAt: string;
  expiresAt: string;
  requestCursor: string | null;
  pageIndex: number;
  startIndex: number;
  changeCount: number;
  changes: readonly PublisherFeedChange[];
  nextCursor: string | null;
};

export type PublisherFeedResetRequired = {
  schemaVersion: 1;
  feedId: string;
  fromSequence: number;
  currentSequence: number;
  generatedAt: string;
  expiresAt: string;
  resetRequired: true;
  snapshotUrl: string;
};

export type PublisherFeedSnapshot = {
  schemaVersion: 1;
  feedId: string;
  publisherId: string;
  handle: string | null;
  displayName: string;
  generatedAt: string;
  expiresAt: string;
  sequence: number;
  entries: readonly PublisherFeedEntry[];
};

type VerifiedPublisherFeedProjection = {
  payload:
    | PublisherFeedSnapshot
    | PublisherFeedQueryPage
    | PublisherFeedChangePage
    | PublisherFeedResetRequired;
  signedBy: string;
  signedByKeyIds: readonly string[];
  signatureCount: number;
  threshold: number;
};

const SNAPSHOT_KEYS = [
  "schemaVersion",
  "feedId",
  "publisherId",
  "handle",
  "displayName",
  "generatedAt",
  "expiresAt",
  "sequence",
  "entries",
] as const;

const QUERY_PAGE_KEYS = [
  "schemaVersion",
  "feedId",
  "sequence",
  "generatedAt",
  "expiresAt",
  "query",
  "requestCursor",
  "pageIndex",
  "startIndex",
  "resultCount",
  "entries",
  "nextCursor",
] as const;
const CHANGE_PAGE_KEYS = [
  "schemaVersion",
  "feedId",
  "fromSequence",
  "toSequence",
  "generatedAt",
  "expiresAt",
  "requestCursor",
  "pageIndex",
  "startIndex",
  "changeCount",
  "changes",
  "nextCursor",
] as const;
const RESET_KEYS = [
  "schemaVersion",
  "feedId",
  "fromSequence",
  "currentSequence",
  "generatedAt",
  "expiresAt",
  "resetRequired",
  "snapshotUrl",
] as const;

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).toSorted().join("\0") === keys.toSorted().join("\0");
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function hasUtf8Length(value: unknown, minimum: number, maximum: number): value is string {
  if (typeof value !== "string") {
    return false;
  }
  const length = new TextEncoder().encode(value).length;
  return length >= minimum && length <= maximum;
}

function isDateString(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function hasValidProjectionBase(value: Record<string, unknown>): boolean {
  return (
    value.schemaVersion === 1 &&
    typeof value.feedId === "string" &&
    value.feedId.length > 0 &&
    isDateString(value.generatedAt) &&
    isDateString(value.expiresAt) &&
    Date.parse(value.expiresAt) > Date.parse(value.generatedAt)
  );
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isEntryKind(value: unknown): value is "skill" | "plugin" {
  return value === "skill" || value === "plugin";
}

function isPublisherFeedEntry(value: unknown): value is PublisherFeedEntry {
  if (!isRecord(value)) {
    return false;
  }
  if (
    !(
      hasExactKeys(value, ["kind", "id", "name", "displayName", "summary", "url", "updatedAt"]) &&
      isEntryKind(value.kind) &&
      typeof value.id === "string" &&
      value.id.length > 0 &&
      typeof value.name === "string" &&
      value.name.length > 0 &&
      typeof value.displayName === "string" &&
      value.displayName.length > 0 &&
      isNullableString(value.summary) &&
      typeof value.url === "string" &&
      value.url.length > 0 &&
      typeof value.updatedAt === "number" &&
      Number.isFinite(value.updatedAt) &&
      value.updatedAt >= 0
    )
  ) {
    return false;
  }
  if (value.url.startsWith("/")) {
    return (
      !value.url.startsWith("//") &&
      !value.url.includes("\\") &&
      !containsAsciiControlCharacter(value.url)
    );
  }
  try {
    const url = new URL(value.url);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}

function containsAsciiControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 0x1f || codeUnit === 0x7f) {
      return true;
    }
  }
  return false;
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

function isPublisherFeedQuery(value: unknown): value is PublisherFeedQuery {
  if (!isRecord(value)) {
    return false;
  }
  const keys = Object.keys(value);
  if (keys.length === 0 || keys.some((key) => key !== "text" && key !== "kinds")) {
    return false;
  }
  if (
    value.text !== undefined &&
    (typeof value.text !== "string" ||
      !value.text ||
      new TextEncoder().encode(value.text).length > 256 ||
      normalizeQueryTextWhitespace(value.text) !== value.text)
  ) {
    return false;
  }
  if (
    value.kinds !== undefined &&
    (!Array.isArray(value.kinds) ||
      value.kinds.length === 0 ||
      !value.kinds.every(isEntryKind) ||
      [...new Set(value.kinds)].toSorted().join("\0") !== value.kinds.join("\0"))
  ) {
    return false;
  }
  return value.text !== undefined || value.kinds !== undefined;
}

function isPublisherFeedChange(value: unknown): value is PublisherFeedChange {
  if (!isRecord(value) || !isSafeNonNegativeInteger(value.sequence)) {
    return false;
  }
  if (value.operation === "upsert") {
    return (
      hasExactKeys(value, ["sequence", "operation", "entry"]) && isPublisherFeedEntry(value.entry)
    );
  }
  if (value.operation === "remove") {
    return (
      hasExactKeys(value, ["sequence", "operation", "entryId", "entryKind"]) &&
      typeof value.entryId === "string" &&
      value.entryId.length > 0 &&
      isEntryKind(value.entryKind)
    );
  }
  if (value.operation !== "metadata" || !isRecord(value.metadata)) {
    return false;
  }
  return (
    hasExactKeys(value, ["sequence", "operation", "metadata"]) &&
    hasExactKeys(value.metadata, ["publisherId", "handle", "displayName"]) &&
    typeof value.metadata.publisherId === "string" &&
    value.metadata.publisherId.length > 0 &&
    isNullableString(value.metadata.handle) &&
    typeof value.metadata.displayName === "string"
  );
}

function parseQueryPage(value: unknown): PublisherFeedQueryPage | null {
  if (!isRecord(value) || !hasExactKeys(value, QUERY_PAGE_KEYS) || !hasValidProjectionBase(value)) {
    return null;
  }
  if (
    !isSafeNonNegativeInteger(value.sequence) ||
    !isPublisherFeedQuery(value.query) ||
    !isNullableString(value.requestCursor) ||
    !isSafeNonNegativeInteger(value.pageIndex) ||
    !isSafeNonNegativeInteger(value.startIndex) ||
    !isSafeNonNegativeInteger(value.resultCount) ||
    !Array.isArray(value.entries) ||
    value.entries.length > 200 ||
    !value.entries.every(isPublisherFeedEntry) ||
    !isNullableString(value.nextCursor) ||
    value.startIndex + value.entries.length > value.resultCount
  ) {
    return null;
  }
  return value as PublisherFeedQueryPage;
}

function parseSnapshot(value: unknown): PublisherFeedSnapshot | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, SNAPSHOT_KEYS) ||
    !hasValidProjectionBase(value) ||
    !hasUtf8Length(value.publisherId, 1, 200) ||
    value.feedId !== `clawhub.publisher.${value.publisherId}` ||
    new TextEncoder().encode(value.feedId).length > 256 ||
    (value.handle !== null && !hasUtf8Length(value.handle, 1, 64)) ||
    !hasUtf8Length(value.displayName, 1, 256) ||
    !isSafeNonNegativeInteger(value.sequence) ||
    !Array.isArray(value.entries) ||
    value.entries.length > 400 ||
    !value.entries.every(isPublisherFeedEntry)
  ) {
    return null;
  }
  const identities = new Set<string>();
  for (const entry of value.entries) {
    const identity = `${entry.kind}\0${entry.id}`;
    if (identities.has(identity)) {
      return null;
    }
    identities.add(identity);
  }
  return value as PublisherFeedSnapshot;
}

function parseChangePayload(
  value: unknown,
): PublisherFeedChangePage | PublisherFeedResetRequired | null {
  if (!isRecord(value) || !hasValidProjectionBase(value)) {
    return null;
  }
  if (value.resetRequired === true) {
    if (
      !hasExactKeys(value, RESET_KEYS) ||
      !isSafeNonNegativeInteger(value.fromSequence) ||
      !isSafeNonNegativeInteger(value.currentSequence) ||
      value.currentSequence < value.fromSequence ||
      typeof value.snapshotUrl !== "string"
    ) {
      return null;
    }
    try {
      if (new URL(value.snapshotUrl).protocol !== "https:") {
        return null;
      }
    } catch {
      return null;
    }
    return value as PublisherFeedResetRequired;
  }
  if (
    !hasExactKeys(value, CHANGE_PAGE_KEYS) ||
    !isSafeNonNegativeInteger(value.fromSequence) ||
    !isSafeNonNegativeInteger(value.toSequence) ||
    value.toSequence < value.fromSequence ||
    !isNullableString(value.requestCursor) ||
    !isSafeNonNegativeInteger(value.pageIndex) ||
    !isSafeNonNegativeInteger(value.startIndex) ||
    !isSafeNonNegativeInteger(value.changeCount) ||
    !Array.isArray(value.changes) ||
    value.changes.length > 500 ||
    !value.changes.every(isPublisherFeedChange) ||
    !isNullableString(value.nextCursor) ||
    value.startIndex + value.changes.length > value.changeCount
  ) {
    return null;
  }
  const fromSequence = value.fromSequence;
  const toSequence = value.toSequence;
  if (
    value.changes.some((change) => change.sequence <= fromSequence || change.sequence > toSequence)
  ) {
    return null;
  }
  return value as PublisherFeedChangePage;
}

export function verifyPublisherFeedProjection(
  raw: unknown,
  params: {
    payloadType:
      | typeof PUBLISHER_FEED_SNAPSHOT_PAYLOAD_TYPE
      | typeof PUBLISHER_FEED_QUERY_PAYLOAD_TYPE
      | typeof PUBLISHER_FEED_CHANGES_PAYLOAD_TYPE;
    trustedKeys: readonly TrustedFeedSigningKey[];
    threshold?: number;
  },
): VerifiedPublisherFeedProjection {
  const verified = verifySignedFeedEnvelopePayload(raw, {
    expectedPayloadType: params.payloadType,
    trustedKeys: params.trustedKeys,
    threshold: params.threshold,
    context: "publisher feed projection",
  });
  if (!verified.ok) {
    throw new Error(verified.message);
  }
  let rawPayload: unknown;
  try {
    rawPayload = JSON.parse(verified.payloadBytes.toString("utf8"));
  } catch {
    throw new Error("publisher feed projection payload is not valid JSON");
  }
  const payload =
    params.payloadType === PUBLISHER_FEED_SNAPSHOT_PAYLOAD_TYPE
      ? parseSnapshot(rawPayload)
      : params.payloadType === PUBLISHER_FEED_QUERY_PAYLOAD_TYPE
        ? parseQueryPage(rawPayload)
        : parseChangePayload(rawPayload);
  if (!payload) {
    throw new Error("publisher feed projection payload is invalid");
  }
  return {
    payload,
    signedBy: verified.signedBy,
    signedByKeyIds: verified.signedByKeyIds,
    signatureCount: verified.signatureCount,
    threshold: verified.threshold,
  };
}

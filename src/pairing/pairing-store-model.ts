import crypto from "node:crypto";
import { parseDateStringTimestampMs } from "@openclaw/normalization-core/number-coercion";
import { resolvePairingRequestAccountId } from "./pairing-store-keys.js";
import type { PairingChannel, PairingRequestRecord } from "./pairing-store.types.js";

const PAIRING_CODE_LENGTH = 8;
const PAIRING_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const PAIRING_CODE_MAX_ATTEMPTS = 500;
export const CHANNEL_PAIRING_PENDING_TTL_MS = 60 * 60 * 1000;
export const CHANNEL_PAIRING_PENDING_MAX = 3;

type PairingRequest = PairingRequestRecord;

/** Stable opaque id for approving a request without exposing its human pairing code. */
export function resolveChannelPairingRequestId(
  channel: PairingChannel,
  request: PairingRequest,
): string {
  const accountId = resolvePairingRequestAccountId(request);
  return crypto
    .createHash("sha256")
    .update(`${channel}\0${accountId}\0${request.id}\0${request.createdAt}`)
    .digest("base64url")
    .slice(0, 32);
}

function isExpired(entry: PairingRequest, nowMs: number): boolean {
  const createdAt = parseDateStringTimestampMs(entry.createdAt);
  return createdAt === undefined || nowMs - createdAt > CHANNEL_PAIRING_PENDING_TTL_MS;
}

export function pruneExpiredRequests(reqs: PairingRequest[], nowMs: number) {
  const requests = reqs.filter((req) => !isExpired(req, nowMs));
  return { requests, removed: requests.length !== reqs.length };
}

function resolveLastSeenAt(entry: PairingRequest): number {
  return (
    parseDateStringTimestampMs(entry.lastSeenAt) ?? parseDateStringTimestampMs(entry.createdAt) ?? 0
  );
}

export function requestMatchesAccountId(
  entry: PairingRequest,
  normalizedAccountId: string,
): boolean {
  return !normalizedAccountId || resolvePairingRequestAccountId(entry) === normalizedAccountId;
}

export function pruneExcessRequestsByAccount(reqs: PairingRequest[]) {
  const grouped = new Map<string, Array<[number, PairingRequest]>>();
  for (const [index, entry] of reqs.entries()) {
    const accountId = resolvePairingRequestAccountId(entry);
    const entries = grouped.get(accountId) ?? [];
    entries.push([index, entry]);
    grouped.set(accountId, entries);
  }

  const droppedIndexes = new Set<number>();
  for (const entries of grouped.values()) {
    const sorted = entries.toSorted(
      ([, left], [, right]) => resolveLastSeenAt(left) - resolveLastSeenAt(right),
    );
    for (const [index] of sorted.slice(0, -CHANNEL_PAIRING_PENDING_MAX)) {
      droppedIndexes.add(index);
    }
  }
  return droppedIndexes.size === 0
    ? { requests: reqs, removed: false }
    : { requests: reqs.filter((_, index) => !droppedIndexes.has(index)), removed: true };
}

function randomCode(): string {
  // Human-friendly: 8 chars, upper, no ambiguous chars (0O1I).
  let out = "";
  for (let i = 0; i < PAIRING_CODE_LENGTH; i++) {
    out += PAIRING_CODE_ALPHABET[crypto.randomInt(0, PAIRING_CODE_ALPHABET.length)];
  }
  return out;
}

export function generateUniqueCode(existing: Set<string>): string {
  for (let attempt = 0; attempt < PAIRING_CODE_MAX_ATTEMPTS; attempt += 1) {
    const code = randomCode();
    if (!existing.has(code)) {
      return code;
    }
  }
  throw new Error(
    `failed to generate unique pairing code after ${PAIRING_CODE_MAX_ATTEMPTS} attempts; existing code count: ${existing.size}`,
  );
}

import { createHash } from "node:crypto";
import { pruneMapToMaxSize } from "../infra/map-size.js";

const OUTBOUND_DEDUPE_WINDOW_MS = 8_000;
const OUTBOUND_GUARD_MAX_KEYS = 4_000;
const OUTBOUND_CIRCUIT_FAILURE_WINDOW_MS = 120_000;
const OUTBOUND_CIRCUIT_MAX_FAILURES = 5;
const OUTBOUND_CIRCUIT_COOLDOWN_MS = 30_000;
const OUTBOUND_GUARD_STALE_MS = Math.max(
  OUTBOUND_DEDUPE_WINDOW_MS,
  OUTBOUND_CIRCUIT_FAILURE_WINDOW_MS,
  OUTBOUND_CIRCUIT_COOLDOWN_MS,
);

type OutboundGuardEntry = {
  lastAttemptAt: number;
  lastFailureAt?: number;
  consecutiveFailures: number;
  blockedUntil?: number;
};

export type TelegramOutboundSendIdentity = {
  accountId: string;
  chatId: string;
  text: string;
  messageThreadId?: number;
};

export type TelegramOutboundSendDecision =
  | {
      blocked: false;
    }
  | {
      blocked: true;
      reason: "duplicate" | "circuit_open";
      retryAfterMs: number;
    };

const outboundGuardEntries = new Map<string, OutboundGuardEntry>();

function normalizeOutboundText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function resolveOutboundKey(identity: TelegramOutboundSendIdentity): string | undefined {
  const normalizedText = normalizeOutboundText(identity.text);
  if (!normalizedText) {
    return undefined;
  }
  const messageThreadId =
    typeof identity.messageThreadId === "number" && Number.isFinite(identity.messageThreadId)
      ? String(Math.trunc(identity.messageThreadId))
      : "-";
  const digest = createHash("sha256").update(normalizedText).digest("hex");
  return `${identity.accountId}:${identity.chatId}:${messageThreadId}:${digest}`;
}

function pruneOutboundGuard(now: number): void {
  const staleCutoff = now - OUTBOUND_GUARD_STALE_MS;
  for (const [key, entry] of outboundGuardEntries) {
    if ((entry.blockedUntil ?? 0) > now) {
      continue;
    }
    if (entry.lastAttemptAt < staleCutoff) {
      outboundGuardEntries.delete(key);
    }
  }
  pruneMapToMaxSize(outboundGuardEntries, OUTBOUND_GUARD_MAX_KEYS);
}

function touchOutboundEntry(key: string, entry: OutboundGuardEntry): void {
  outboundGuardEntries.delete(key);
  outboundGuardEntries.set(key, entry);
}

export function reserveTelegramOutboundSend(
  identity: TelegramOutboundSendIdentity,
  now = Date.now(),
): TelegramOutboundSendDecision {
  const key = resolveOutboundKey(identity);
  if (!key) {
    return { blocked: false };
  }
  pruneOutboundGuard(now);

  const entry = outboundGuardEntries.get(key);
  if (entry?.blockedUntil && entry.blockedUntil > now) {
    touchOutboundEntry(key, entry);
    return {
      blocked: true,
      reason: "circuit_open",
      retryAfterMs: Math.max(1, entry.blockedUntil - now),
    };
  }
  if (entry?.lastAttemptAt && now - entry.lastAttemptAt < OUTBOUND_DEDUPE_WINDOW_MS) {
    const retryAfterMs = OUTBOUND_DEDUPE_WINDOW_MS - (now - entry.lastAttemptAt);
    touchOutboundEntry(key, entry);
    return {
      blocked: true,
      reason: "duplicate",
      retryAfterMs: Math.max(1, retryAfterMs),
    };
  }

  const nextEntry: OutboundGuardEntry = entry ?? {
    lastAttemptAt: now,
    consecutiveFailures: 0,
  };
  nextEntry.lastAttemptAt = now;
  if (entry?.blockedUntil && entry.blockedUntil <= now) {
    nextEntry.blockedUntil = undefined;
  }
  touchOutboundEntry(key, nextEntry);
  return { blocked: false };
}

export function markTelegramOutboundSendSuccess(
  identity: TelegramOutboundSendIdentity,
  now = Date.now(),
): void {
  const key = resolveOutboundKey(identity);
  if (!key) {
    return;
  }
  const entry =
    outboundGuardEntries.get(key) ??
    ({
      lastAttemptAt: now,
      consecutiveFailures: 0,
    } satisfies OutboundGuardEntry);
  entry.lastAttemptAt = now;
  entry.consecutiveFailures = 0;
  entry.lastFailureAt = undefined;
  entry.blockedUntil = undefined;
  touchOutboundEntry(key, entry);
  pruneOutboundGuard(now);
}

export function markTelegramOutboundSendFailure(
  identity: TelegramOutboundSendIdentity,
  now = Date.now(),
): void {
  const key = resolveOutboundKey(identity);
  if (!key) {
    return;
  }
  const entry =
    outboundGuardEntries.get(key) ??
    ({
      lastAttemptAt: now,
      consecutiveFailures: 0,
    } satisfies OutboundGuardEntry);

  entry.lastAttemptAt = now;
  const withinWindow =
    typeof entry.lastFailureAt === "number" &&
    now - entry.lastFailureAt <= OUTBOUND_CIRCUIT_FAILURE_WINDOW_MS;
  entry.consecutiveFailures = withinWindow ? entry.consecutiveFailures + 1 : 1;
  entry.lastFailureAt = now;

  if (entry.consecutiveFailures >= OUTBOUND_CIRCUIT_MAX_FAILURES) {
    entry.blockedUntil = now + OUTBOUND_CIRCUIT_COOLDOWN_MS;
    entry.consecutiveFailures = 0;
  }

  touchOutboundEntry(key, entry);
  pruneOutboundGuard(now);
}

export function clearTelegramOutboundSendGuard(): void {
  outboundGuardEntries.clear();
}

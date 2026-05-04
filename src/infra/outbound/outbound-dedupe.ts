import path from "node:path";
import { resolveStateDir } from "../../config/paths.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { withFileLock, type FileLockOptions } from "../../plugin-sdk/file-lock.js";
import { readJsonFileWithFallback, writeJsonFileAtomically } from "../../plugin-sdk/json-store.js";
import {
  createPersistentDedupe,
  type PersistentDedupe,
} from "../../plugin-sdk/persistent-dedupe.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";

const log = createSubsystemLogger("outbound/dedupe");

const OUTBOUND_DEDUPE_SINGLETON_KEY = Symbol.for("openclaw.outboundSendDedupe");
const OUTBOUND_DEDUPE_DIRNAME = "outbound-dedupe";

// 30 minutes: long enough to survive crash recovery windows and normal retry storms.
export const OUTBOUND_DEDUPE_TTL_MS = 30 * 60_000;
const OUTBOUND_DEDUPE_MEMORY_MAX = 2000;
const OUTBOUND_DEDUPE_FILE_MAX = 1000;
const inFlightOutboundKeys = new Set<string>();

type OutboundDedupeData = Record<string, number>;

const OUTBOUND_DEDUPE_LOCK_OPTIONS: FileLockOptions = {
  retries: {
    retries: 6,
    factor: 1.35,
    minTimeout: 8,
    maxTimeout: 180,
    randomize: true,
  },
  stale: 60_000,
};

function outboundDedupeFilePath(namespace: string): string {
  return path.join(resolveStateDir(), OUTBOUND_DEDUPE_DIRNAME, `${namespace}.json`);
}

function sanitizeData(value: unknown): OutboundDedupeData {
  if (!value || typeof value !== "object") {
    return {};
  }
  const out: OutboundDedupeData = {};
  for (const [key, ts] of Object.entries(value as Record<string, unknown>)) {
    if (typeof ts === "number" && Number.isFinite(ts) && ts > 0) {
      out[key] = ts;
    }
  }
  return out;
}

function pruneData(data: OutboundDedupeData, now: number): void {
  for (const [key, ts] of Object.entries(data)) {
    if (now - ts >= OUTBOUND_DEDUPE_TTL_MS) {
      delete data[key];
    }
  }
  const keys = Object.keys(data);
  if (keys.length <= OUTBOUND_DEDUPE_FILE_MAX) {
    return;
  }
  keys
    .toSorted((a, b) => data[a] - data[b])
    .slice(0, keys.length - OUTBOUND_DEDUPE_FILE_MAX)
    .forEach((key) => {
      delete data[key];
    });
}

async function hasCompletedOutboundSend(
  key: string,
  namespace: string,
  now = Date.now(),
): Promise<boolean> {
  const filePath = outboundDedupeFilePath(namespace);
  const { value } = await readJsonFileWithFallback<OutboundDedupeData>(filePath, {});
  const data = sanitizeData(value);
  const seenAt = data[key];
  return seenAt != null && now - seenAt < OUTBOUND_DEDUPE_TTL_MS;
}

export async function recordOutboundSendCompleted(
  key: string,
  opts?: { namespace?: string },
): Promise<void> {
  const trimmed = key.trim();
  if (!trimmed) {
    return;
  }
  const namespace = opts?.namespace ?? "global";
  const filePath = outboundDedupeFilePath(namespace);
  const now = Date.now();
  await withFileLock(filePath, OUTBOUND_DEDUPE_LOCK_OPTIONS, async () => {
    const { value } = await readJsonFileWithFallback<OutboundDedupeData>(filePath, {});
    const data = sanitizeData(value);
    data[trimmed] = now;
    pruneData(data, now);
    await writeJsonFileAtomically(filePath, data);
  });
}

function createOutboundDedupe(stateDir?: string): PersistentDedupe {
  return createPersistentDedupe({
    ttlMs: OUTBOUND_DEDUPE_TTL_MS,
    memoryMaxSize: OUTBOUND_DEDUPE_MEMORY_MAX,
    fileMaxEntries: OUTBOUND_DEDUPE_FILE_MAX,
    resolveFilePath: (namespace) => {
      const base = stateDir ?? resolveStateDir();
      return path.join(base, OUTBOUND_DEDUPE_DIRNAME, `${namespace}.json`);
    },
    onDiskError: (err) => {
      log.warn(`outbound dedupe disk error (falling back to memory): ${String(err)}`);
    },
  });
}

/** Singleton persistent dedupe for outbound sends. Survives in-process restarts. */
export function getOutboundSendDedupe(): PersistentDedupe {
  return resolveGlobalSingleton(OUTBOUND_DEDUPE_SINGLETON_KEY, () => createOutboundDedupe());
}

/**
 * Build a deterministic idempotency key for a Discord-originated outbound WhatsApp message.
 *
 * The key encodes the inbound Discord message ID + recipient + channel + payload position
 * so that the same logical send always maps to the same key, even across process restarts.
 */
export function buildDiscordOutboundIdempotencyKey(params: {
  discordMessageId: string;
  channel: string;
  to: string;
  accountId?: string;
  payloadIndex?: number;
}): string {
  const { discordMessageId, channel, to, accountId, payloadIndex } = params;
  return [
    "discord-wa",
    channel,
    to,
    accountId ?? "",
    discordMessageId,
    String(payloadIndex ?? 0),
  ].join("|");
}

/**
 * Build a deterministic idempotency key for tool-driven outbound sends.
 *
 * This covers paths where a Discord/forum message invokes the `message` tool
 * to send to another channel (notably Discord #wa-aprovacoes → WhatsApp).
 * The key includes a source message id when available plus a compact payload
 * fingerprint, so replays of the same tool call are suppressed without blocking
 * distinct messages from the same source turn.
 */
export function buildToolOutboundIdempotencyKey(params: {
  sourceChannel?: string;
  sourceMessageId?: string | number;
  targetChannel: string;
  to: string;
  accountId?: string;
  content?: string;
  mediaUrls?: readonly string[];
}): string | undefined {
  if (params.sourceMessageId == null || String(params.sourceMessageId).trim() === "") {
    return undefined;
  }
  const payloadFingerprint = JSON.stringify({
    content: params.content ?? "",
    mediaUrls: params.mediaUrls ?? [],
  });
  return [
    "tool-outbound",
    params.sourceChannel ?? "unknown",
    String(params.sourceMessageId),
    params.targetChannel,
    params.to,
    params.accountId ?? "",
    payloadFingerprint,
  ].join("|");
}

/**
 * Claim an outbound idempotency key before attempting a send.
 *
 * Previously completed keys are suppressed from the persistent ledger, while
 * concurrent in-process replays are suppressed through an in-flight set. The
 * caller must call `finishOutboundSendAttempt(key)` after the send attempt.
 */
export async function beginOutboundSendAttempt(
  key: string,
  opts?: { namespace?: string; dedupe?: PersistentDedupe },
): Promise<{ shouldSend: boolean }> {
  const trimmed = key.trim();
  if (!trimmed) {
    return { shouldSend: true };
  }
  const namespace = opts?.namespace ?? "global";
  const scopedKey = `${namespace}:${trimmed}`;
  if (inFlightOutboundKeys.has(scopedKey)) {
    log.info(`duplicate_suppressed key=${trimmed}`);
    return { shouldSend: false };
  }
  if (opts?.dedupe) {
    const isNew = await opts.dedupe.checkAndRecord(trimmed, { namespace });
    if (!isNew) {
      log.info(`duplicate_suppressed key=${trimmed}`);
      return { shouldSend: false };
    }
  } else if (await hasCompletedOutboundSend(trimmed, namespace).catch(() => false)) {
    log.info(`duplicate_suppressed key=${trimmed}`);
    return { shouldSend: false };
  }
  inFlightOutboundKeys.add(scopedKey);
  return { shouldSend: true };
}

/** Finish a claimed outbound send attempt. Successful attempts stay in ledger. */
export function finishOutboundSendAttempt(key: string, opts?: { namespace?: string }): void {
  const trimmed = key.trim();
  if (!trimmed) {
    return;
  }
  inFlightOutboundKeys.delete(`${opts?.namespace ?? "global"}:${trimmed}`);
}

/**
 * Check whether this outbound send has already been recorded, and record it if not.
 *
 * Returns `{ isDuplicate: true }` when the key was already seen within the TTL window,
 * which means the caller should skip the actual send and log `duplicate_suppressed`.
 *
 * On disk errors the function conservatively allows the send to proceed (fail-open).
 */
export async function checkAndRecordOutboundSend(
  key: string,
  opts?: { namespace?: string; dedupe?: PersistentDedupe },
): Promise<{ isDuplicate: boolean }> {
  const dedupe = opts?.dedupe ?? getOutboundSendDedupe();
  const isNew = await dedupe.checkAndRecord(key, { namespace: opts?.namespace ?? "global" });
  if (!isNew) {
    log.info(`duplicate_suppressed key=${key}`);
    return { isDuplicate: true };
  }
  return { isDuplicate: false };
}

/** Clear in-memory state — used in tests. */
export function resetOutboundSendDedupeMemory(): void {
  getOutboundSendDedupe().clearMemory();
  inFlightOutboundKeys.clear();
}

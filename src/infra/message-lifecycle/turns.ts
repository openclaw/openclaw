import { buildInboundDedupeKey } from "../../auto-reply/reply/inbound-dedupe.js";
import type { MsgContext } from "../../auto-reply/templating.js";
import { logVerbose } from "../../globals.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { generateSecureUuid } from "../secure-random.js";
import { getLifecycleDb, runLifecycleTransaction } from "./db.js";

export const TURN_PRUNE_AGE_MS = 48 * 60 * 60_000; // 48h
export const MAX_TURN_RECOVERY_ATTEMPTS = 3;
export const MAX_TURN_RECOVERY_AGE_MS = 24 * 60 * 60_000; // 24h
const TURN_RECOVERY_BACKOFF_MS = 15_000;

const DEDUPE_FALLBACK_TTL_MS = 10 * 60_000;
const JOURNAL_WARN_THROTTLE_MS = 60_000;

const dedupeFallbackCache = new Map<string, number>();
let lastJournalWarnAt = 0;
const log = createSubsystemLogger("message-lifecycle/turns");

/**
 * In-process registry of turn IDs currently being dispatched on the live path.
 * The recovery worker checks this set to avoid replaying turns that are still
 * actively being processed. On crash, this set is lost — which is exactly correct:
 * the new process has no active turns, so all orphans become eligible for recovery.
 */
const activeTurnIds = new Set<string>();

export function registerActiveTurn(id: string): void {
  activeTurnIds.add(id);
}

export function unregisterActiveTurn(id: string): void {
  activeTurnIds.delete(id);
}

export function isTurnActive(id: string): boolean {
  return activeTurnIds.has(id);
}

const NON_TERMINAL_STATES = [
  "accepted",
  "running",
  "delivery_pending",
  "failed_retryable",
] as const;

export type TurnStatus =
  | (typeof NON_TERMINAL_STATES)[number]
  | "delivered"
  | "aborted"
  | "failed_terminal";

export type TurnRow = {
  id: string;
  channel: string;
  account_id: string;
  external_id: string | null;
  session_key: string;
  payload: string;
  accepted_at: number;
  status: TurnStatus;
  attempt_count: number;
  updated_at: number;
  terminal_reason: string | null;
};

export type AcceptTurnResult = {
  accepted: boolean;
  id: string;
};

export type RecoveryFailureResult = {
  attempts: number;
  markedFailed: boolean;
};

function stringifyOptional(value: unknown): string | undefined {
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  return undefined;
}

function warnJournalFailure(message: string): void {
  const now = Date.now();
  if (now - lastJournalWarnAt >= JOURNAL_WARN_THROTTLE_MS) {
    lastJournalWarnAt = now;
    log.warn(message);
    return;
  }
  logVerbose(`message-lifecycle/turns: ${message}`);
}

function cleanupDedupeFallback(now: number): void {
  for (const [key, seenAt] of dedupeFallbackCache) {
    if (now - seenAt > DEDUPE_FALLBACK_TTL_MS) {
      dedupeFallbackCache.delete(key);
    }
  }
}

function acceptFromDedupeFallback(key: string, now: number): boolean {
  cleanupDedupeFallback(now);
  const previous = dedupeFallbackCache.get(key);
  dedupeFallbackCache.set(key, now);
  return previous === undefined || now - previous > DEDUPE_FALLBACK_TTL_MS;
}

function buildFallbackDedupeKey(channel: string, accountId: string, externalId: string): string {
  return `${channel}\u0000${accountId}\u0000${externalId}`;
}

function buildStoredPayload(ctx: MsgContext): string {
  return JSON.stringify({
    Body: ctx.Body,
    BodyForAgent: ctx.BodyForAgent,
    BodyForCommands: ctx.BodyForCommands,
    RawBody: ctx.RawBody,
    CommandBody: ctx.CommandBody,
    From: ctx.From,
    To: ctx.To,
    SessionKey: ctx.SessionKey,
    AccountId: ctx.AccountId,
    MessageSid: ctx.MessageSid,
    MessageSidFull: ctx.MessageSidFull,
    MessageTurnId: ctx.MessageTurnId,
    ReplyToId: ctx.ReplyToId,
    ChatType: ctx.ChatType,
    Provider: ctx.Provider,
    Surface: ctx.Surface,
    OriginatingChannel:
      typeof ctx.OriginatingChannel === "string" ? ctx.OriginatingChannel : undefined,
    OriginatingTo: ctx.OriginatingTo,
    CommandAuthorized: ctx.CommandAuthorized,
    CommandSource: ctx.CommandSource,
    CommandTargetSessionKey: ctx.CommandTargetSessionKey,
    SenderId: ctx.SenderId,
    SenderName: ctx.SenderName,
    SenderUsername: ctx.SenderUsername,
    SenderE164: ctx.SenderE164,
    WasMentioned: ctx.WasMentioned,
    IsForum: ctx.IsForum,
    Timestamp: ctx.Timestamp,
    MessageThreadId: stringifyOptional(ctx.MessageThreadId),
    ConversationLabel: ctx.ConversationLabel,
    GroupSubject: ctx.GroupSubject,
    GroupChannel: ctx.GroupChannel,
    GroupSpace: ctx.GroupSpace,
    GroupMembers: ctx.GroupMembers,
    HookMessages: ctx.HookMessages,
  });
}

function readString(raw: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = raw[key];
    if (typeof value !== "string") {
      continue;
    }
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }
  return undefined;
}

function readBoolean(raw: Record<string, unknown>, ...keys: string[]): boolean | undefined {
  for (const key of keys) {
    const value = raw[key];
    if (typeof value === "boolean") {
      return value;
    }
  }
  return undefined;
}

function readNumber(raw: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = raw[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string" && value.trim()) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }
  return undefined;
}

function readStringArray(raw: Record<string, unknown>, ...keys: string[]): string[] | undefined {
  for (const key of keys) {
    const value = raw[key];
    if (!Array.isArray(value)) {
      continue;
    }
    const resolved = value
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    if (resolved.length > 0) {
      return resolved;
    }
  }
  return undefined;
}

function readThreadId(raw: Record<string, unknown>): string | number | undefined {
  const value = raw.MessageThreadId ?? raw.threadId;
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return undefined;
    }
    const parsed = Number(trimmed);
    if (Number.isInteger(parsed) && String(parsed) === trimmed) {
      return parsed;
    }
    return trimmed;
  }
  return undefined;
}

export function hydrateTurnContext(turn: TurnRow): MsgContext | null {
  let raw: Record<string, unknown>;
  try {
    const parsed = JSON.parse(turn.payload) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    raw = parsed as Record<string, unknown>;
  } catch {
    return null;
  }

  const to = readString(raw, "To", "to");
  const originatingTo = readString(raw, "OriginatingTo", "originatingTo", "chatId") ?? to;
  const originatingChannel =
    readString(raw, "OriginatingChannel", "originatingChannel") ??
    (turn.channel.trim() ? turn.channel : undefined);
  const fallbackAccountId = turn.account_id.trim() ? turn.account_id : undefined;
  const fallbackMessageSid = turn.external_id?.trim() ? turn.external_id : undefined;
  if (!originatingTo || !originatingChannel) {
    return null;
  }

  return {
    Body: readString(raw, "Body", "body"),
    BodyForAgent: readString(raw, "BodyForAgent", "bodyForAgent"),
    BodyForCommands: readString(raw, "BodyForCommands", "bodyForCommands"),
    RawBody: readString(raw, "RawBody", "rawBody"),
    CommandBody: readString(raw, "CommandBody", "commandBody"),
    From: readString(raw, "From", "from", "user"),
    To: to ?? originatingTo,
    SessionKey: readString(raw, "SessionKey", "sessionKey") ?? turn.session_key,
    AccountId: readString(raw, "AccountId", "accountId") ?? fallbackAccountId,
    MessageSid: readString(raw, "MessageSid", "messageId") ?? fallbackMessageSid,
    MessageSidFull: readString(raw, "MessageSidFull", "messageIdFull"),
    MessageTurnId: turn.id,
    ReplyToId: readString(raw, "ReplyToId", "replyToId"),
    ChatType: readString(raw, "ChatType", "chatType"),
    Provider: readString(raw, "Provider", "provider"),
    Surface: readString(raw, "Surface", "surface"),
    OriginatingChannel: originatingChannel,
    OriginatingTo: originatingTo,
    CommandAuthorized: readBoolean(raw, "CommandAuthorized", "commandAuthorized"),
    CommandSource: readString(raw, "CommandSource", "commandSource") as
      | "text"
      | "native"
      | undefined,
    CommandTargetSessionKey: readString(raw, "CommandTargetSessionKey", "commandTargetSessionKey"),
    SenderId: readString(raw, "SenderId", "senderId"),
    SenderName: readString(raw, "SenderName", "senderName", "userName"),
    SenderUsername: readString(raw, "SenderUsername", "senderUsername"),
    SenderE164: readString(raw, "SenderE164", "senderE164"),
    WasMentioned: readBoolean(raw, "WasMentioned", "wasMentioned"),
    IsForum: readBoolean(raw, "IsForum", "isForum"),
    Timestamp: readNumber(raw, "Timestamp", "timestamp"),
    MessageThreadId: readThreadId(raw),
    ConversationLabel: readString(raw, "ConversationLabel", "conversationLabel"),
    GroupSubject: readString(raw, "GroupSubject", "groupSubject"),
    GroupChannel: readString(raw, "GroupChannel", "groupChannel"),
    GroupSpace: readString(raw, "GroupSpace", "groupSpace"),
    GroupMembers: readString(raw, "GroupMembers", "groupMembers"),
    HookMessages: readStringArray(raw, "HookMessages", "hookMessages"),
  };
}

export function acceptTurn(
  ctx: MsgContext,
  opts?: { stateDir?: string; turnId?: string },
): AcceptTurnResult {
  const db = getLifecycleDb(opts?.stateDir);
  const id = opts?.turnId?.trim() || generateSecureUuid();
  const now = Date.now();
  // Keep durable turn tracking enabled while deferring persistent dedupe to the
  // existing inbound dedupe path until per-channel message identity semantics
  // are fully normalized (for example callback/query ids vs message ids).
  const disablePersistentDedupe = true;
  const dedupeKey = disablePersistentDedupe ? undefined : (buildInboundDedupeKey(ctx) ?? undefined);
  const externalId = disablePersistentDedupe ? null : ctx.MessageSid?.trim() || null;
  const channel = String(ctx.OriginatingChannel ?? ctx.Surface ?? ctx.Provider ?? "").toLowerCase();
  const accountId = ctx.AccountId?.trim() ?? "";
  const sessionKey = ctx.SessionKey?.trim() ?? "";
  const routeTo = ctx.OriginatingTo?.trim() || ctx.To?.trim() || "";
  const routeChannel = String(
    ctx.OriginatingChannel ?? ctx.Surface ?? ctx.Provider ?? "",
  ).toLowerCase();
  const payload = buildStoredPayload(ctx);
  const routeThreadId = stringifyOptional(ctx.MessageThreadId);
  const routeReplyToId = stringifyOptional(ctx.ReplyToId);

  try {
    if (dedupeKey && externalId) {
      db.prepare(
        `INSERT OR IGNORE INTO message_turns
           (id, channel, account_id, external_id, dedupe_key, session_key, payload,
            route_channel, route_to, route_account_id, route_thread_id, route_reply_to_id,
            accepted_at, updated_at, status, attempt_count, next_attempt_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', 0, ?)`,
      ).run(
        id,
        channel,
        accountId,
        externalId,
        dedupeKey,
        sessionKey,
        payload,
        routeChannel,
        routeTo,
        accountId || null,
        routeThreadId ?? null,
        routeReplyToId ?? null,
        now,
        now,
        now,
      );
      const changes = db.prepare("SELECT changes() AS c").get() as { c: number };
      return { accepted: changes.c > 0, id };
    }

    db.prepare(
      `INSERT INTO message_turns
         (id, channel, account_id, external_id, dedupe_key, session_key, payload,
          route_channel, route_to, route_account_id, route_thread_id, route_reply_to_id,
          accepted_at, updated_at, status, attempt_count, next_attempt_at)
       VALUES (?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', 0, ?)`,
    ).run(
      id,
      channel,
      accountId,
      sessionKey,
      payload,
      routeChannel,
      routeTo,
      accountId || null,
      routeThreadId ?? null,
      routeReplyToId ?? null,
      now,
      now,
      now,
    );
    return { accepted: true, id };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    if (dedupeKey && externalId) {
      const fallbackKey = dedupeKey ?? buildFallbackDedupeKey(channel, accountId, externalId);
      const accepted = acceptFromDedupeFallback(fallbackKey, now);
      warnJournalFailure(
        `acceptTurn failed (${errMsg}); using in-memory dedupe fallback for ${channel}/${accountId}/${externalId} (accepted=${accepted})`,
      );
      return { accepted, id };
    }
    warnJournalFailure(`acceptTurn failed without dedupe key (${errMsg}); fail-open accepting`);
    return { accepted: true, id };
  }
}

export function markTurnRunning(id: string, opts?: { stateDir?: string }): void {
  const db = getLifecycleDb(opts?.stateDir);
  try {
    db.prepare(
      `UPDATE message_turns
         SET status='running', updated_at=?
       WHERE id=? AND status IN ('accepted','failed_retryable')`,
    ).run(Date.now(), id);
  } catch (err) {
    logVerbose(`message-lifecycle/turns: markTurnRunning failed: ${String(err)}`);
  }
}

export function markTurnDeliveryPending(id: string, opts?: { stateDir?: string }): void {
  const db = getLifecycleDb(opts?.stateDir);
  try {
    db.prepare(
      `UPDATE message_turns
         SET status='delivery_pending', updated_at=?
       WHERE id=? AND status IN ('accepted','running','failed_retryable')`,
    ).run(Date.now(), id);
  } catch (err) {
    logVerbose(`message-lifecycle/turns: markTurnDeliveryPending failed: ${String(err)}`);
  }
}

function mapTerminalStatus(status: "delivered" | "aborted" | "failed"): TurnStatus {
  if (status === "failed") {
    return "failed_terminal";
  }
  return status;
}

export function finalizeTurn(
  id: string,
  status: "delivered" | "aborted" | "failed",
  opts?: { stateDir?: string },
): void {
  const db = getLifecycleDb(opts?.stateDir);
  const now = Date.now();
  try {
    db.prepare(
      `UPDATE message_turns
         SET status=?, updated_at=?, completed_at=?
       WHERE id=? AND status IN ('accepted','running','delivery_pending','failed_retryable')`,
    ).run(mapTerminalStatus(status), now, now, id);
  } catch (err) {
    logVerbose(`message-lifecycle/turns: finalizeTurn failed: ${String(err)}`);
  }
}

export function recordTurnRecoveryFailure(
  id: string,
  error: string,
  opts?: { stateDir?: string; backoffMs?: number },
): RecoveryFailureResult {
  const db = getLifecycleDb(opts?.stateDir);
  const backoffMs = opts?.backoffMs ?? TURN_RECOVERY_BACKOFF_MS;
  try {
    return runLifecycleTransaction(db, () => {
      const row = db
        .prepare(`SELECT attempt_count, status FROM message_turns WHERE id=?`)
        .get(id) as { attempt_count: number; status: string } | undefined;
      if (
        !row ||
        !NON_TERMINAL_STATES.includes(row.status as (typeof NON_TERMINAL_STATES)[number])
      ) {
        return { attempts: 0, markedFailed: false };
      }
      const attempts = row.attempt_count + 1;
      const now = Date.now();
      if (attempts >= MAX_TURN_RECOVERY_ATTEMPTS) {
        db.prepare(
          `UPDATE message_turns
             SET status='failed_terminal',
                 attempt_count=?,
                 updated_at=?,
                 completed_at=?,
                 terminal_reason=?
           WHERE id=?`,
        ).run(attempts, now, now, error, id);
        return { attempts, markedFailed: true };
      }
      db.prepare(
        `UPDATE message_turns
           SET status='failed_retryable',
               attempt_count=?,
               updated_at=?,
               next_attempt_at=?,
               terminal_reason=?
         WHERE id=?`,
      ).run(attempts, now, now + backoffMs, error, id);
      return { attempts, markedFailed: false };
    });
  } catch (err) {
    logVerbose(`message-lifecycle/turns: recordTurnRecoveryFailure failed: ${String(err)}`);
    return { attempts: 0, markedFailed: false };
  }
}

export function listRecoverableTurns(opts?: {
  minAgeMs?: number;
  maxAgeMs?: number;
  stateDir?: string;
}): TurnRow[] {
  const db = getLifecycleDb(opts?.stateDir);
  const now = Date.now();
  const minAge = opts?.minAgeMs ?? 0;
  const maxAge = opts?.maxAgeMs ?? MAX_TURN_RECOVERY_AGE_MS;
  const newerThan = now - maxAge;
  const olderThan = now - minAge;
  try {
    return db
      .prepare(
        `SELECT
           id,
           channel,
           account_id,
           external_id,
           session_key,
           payload,
           accepted_at,
           status,
           attempt_count,
           updated_at,
           terminal_reason
         FROM message_turns
         WHERE status IN ('accepted','running','delivery_pending','failed_retryable')
           AND accepted_at >= ?
           AND accepted_at <= ?
           AND next_attempt_at <= ?
         ORDER BY accepted_at ASC`,
      )
      .all(newerThan, olderThan, now) as TurnRow[];
  } catch (err) {
    logVerbose(`message-lifecycle/turns: listRecoverableTurns failed: ${String(err)}`);
    return [];
  }
}

export function failStaleTurns(
  maxAgeMs: number = MAX_TURN_RECOVERY_AGE_MS,
  opts?: { stateDir?: string },
): number {
  const db = getLifecycleDb(opts?.stateDir);
  const cutoff = Date.now() - maxAgeMs;
  const now = Date.now();
  try {
    const result = db
      .prepare(
        `UPDATE message_turns
           SET status='failed_terminal',
               updated_at=?,
               completed_at=?,
               terminal_reason='stale turn exceeded recovery age'
         WHERE status IN ('accepted','running','delivery_pending','failed_retryable')
           AND accepted_at < ?`,
      )
      .run(now, now, cutoff);
    return Number(result.changes);
  } catch (err) {
    logVerbose(`message-lifecycle/turns: failStaleTurns failed: ${String(err)}`);
    return 0;
  }
}

export function abortTurnsForSession(sessionKey: string, opts?: { stateDir?: string }): void {
  if (!sessionKey.trim()) {
    return;
  }
  const db = getLifecycleDb(opts?.stateDir);
  const now = Date.now();
  try {
    db.prepare(
      `UPDATE message_turns
         SET status='aborted',
             updated_at=?,
             completed_at=?
       WHERE session_key=?
         AND status IN ('accepted','running','delivery_pending','failed_retryable')`,
    ).run(now, now, sessionKey.trim());
  } catch (err) {
    logVerbose(`message-lifecycle/turns: abortTurnsForSession failed: ${String(err)}`);
  }
}

export function pruneTurns(ageMs: number, opts?: { stateDir?: string }): void {
  const db = getLifecycleDb(opts?.stateDir);
  const cutoff = Date.now() - ageMs;
  try {
    db.prepare(
      `DELETE FROM message_turns
        WHERE status IN ('delivered','aborted','failed_terminal')
          AND COALESCE(completed_at, updated_at, accepted_at) < ?`,
    ).run(cutoff);
  } catch (err) {
    logVerbose(`message-lifecycle/turns: pruneTurns failed: ${String(err)}`);
  }
}

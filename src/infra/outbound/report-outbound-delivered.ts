import { buildCanonicalSentMessageHookContext } from "../../hooks/message-hook-mappers.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { emitCanonicalMessageSent } from "./emit-canonical-message-sent.js";

const log = createSubsystemLogger("outbound/delivery-report");

/**
 * A report that a channel plugin has itself delivered an outbound message
 * through its own provider path (i.e. NOT through core's central outbound
 * delivery path, which already emits the canonical event).
 *
 * This is a *delivery-report contract*, not a raw hook emitter: callers describe
 * WHAT was delivered; the helper owns HOW that becomes the canonical
 * `message.sent` event. Extensions never touch `emitMessageSent`,
 * `createInternalHookEvent`, or the hook runner.
 */
export type OutboundDeliveryReport = {
  /** Channel id, e.g. "whatsapp". */
  channel: string;
  /** Recipient/target id (user/conversation/group). */
  to: string;
  /**
   * Conversation session key. REQUIRED to emit the internal `message:sent` hook.
   * If omitted the report fails open: a debug line is logged and the internal
   * hook is skipped (the plugin `message_sent` hook may still fire). Delivery is
   * never blocked by a missing session key.
   */
  sessionKey?: string;
  /**
   * Outcome of the delivery ATTEMPT: true = provider accepted, false = rejected.
   * Both are valid inputs — this seam reports the *result* of an outbound attempt
   * and emits a canonical `message:sent` carrying `success`, matching the
   * explicit-send path (core's central outbound delivery emits for both outcomes).
   * Consumers gate on `success`. The WhatsApp native caller only reports after
   * `providerAccepted`, so it never passes `false` today.
   */
  success: boolean;
  /**
   * Message body. Used by downstream consumers for type/preview classification.
   * This helper performs NO durable persistence of the body itself — it only
   * passes it through the existing canonical event, exactly as core does today.
   */
  content?: string;
  /** Provider/outbound message id, if known. Primary idempotency key. */
  messageId?: string;
  /** Inbound correlation id, if known. Secondary idempotency key. */
  correlationId?: string;
  /** Sending account id, if applicable. */
  accountId?: string;
  /** Group flags, where applicable. */
  isGroup?: boolean;
  groupId?: string;
  /** Provider error string when `success === false`. */
  error?: string;
};

// Bounded TTL dedupe: idempotency on a recipient+account-scoped key
// (messageId | correlationId), so a provider id reused across recipients or
// accounts on the same channel cannot collide and suppress a valid report.
// Guards against a plugin reporting the same delivery twice (e.g. a retry the
// provider had already accepted). Distinct messages (distinct messageId) are
// NEVER deduped, so multiple replies within one turn each report exactly once.
// HARD bound: the map never exceeds MAX_TRACKED — expired entries are pruned and,
// if still at the cap, the oldest entries are FIFO-evicted (Map preserves insertion
// order). Under pathological unique-key pressure (>MAX_TRACKED within the TTL) the
// oldest key may be evicted before its TTL, allowing a rare re-emit — an acceptable
// trade for a guaranteed memory bound, since dedupe is best-effort.
const REPORT_TTL_MS = 5 * 60 * 1000;
const MAX_TRACKED = 4000;
const seen = new Map<string, number>(); // idempotency key -> expiry (epoch ms)

function idempotencyKey(report: OutboundDeliveryReport): string | null {
  // Scope by channel + account + recipient so a provider message id (or inbound
  // correlation id) reused across accounts/recipients on the same channel cannot
  // collide and wrongly suppress a distinct, valid delivery report.
  const scope = `${report.channel}:${report.accountId ?? ""}:${report.to}`;
  if (report.messageId) {
    return `m:${scope}:${report.messageId}`;
  }
  if (report.correlationId) {
    return `c:${scope}:${report.correlationId}`;
  }
  return null; // no stable id → cannot dedupe; treat as unique
}

function alreadyReported(key: string | null, now: number): boolean {
  if (!key) {
    return false;
  }
  const exp = seen.get(key);
  if (exp != null && exp > now) {
    return true;
  }
  // Hard-cap the map: drop expired first, then FIFO-evict the oldest entries
  // until strictly under the cap, so size never exceeds MAX_TRACKED after insert.
  if (seen.size >= MAX_TRACKED) {
    for (const [k, e] of seen) {
      if (e <= now) {
        seen.delete(k);
      }
    }
    while (seen.size >= MAX_TRACKED) {
      const oldest = seen.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      seen.delete(oldest);
    }
  }
  seen.set(key, now + REPORT_TTL_MS);
  return false;
}

/**
 * Generic, channel-agnostic outbound delivery-report seam.
 *
 * A channel plugin calls this AFTER it has self-delivered an outbound message.
 * The helper translates the report into the existing canonical `message.sent` /
 * MessageSentEvent path, so every consumer that observes core sends (the
 * `message_sent` plugin hook and the internal `message:sent` hook) also observes
 * plugin-self-delivered sends — uniformly, without the plugin reaching into core
 * or knowing about any consumer's bookkeeping.
 *
 * Contract:
 *  - Best-effort / fail-open: never throws; a reporting failure must never affect
 *    or block the delivery that already happened.
 *  - Idempotent on `messageId` (preferred) or `channel`+`to`+`correlationId`.
 *  - `sessionKey` missing → observable debug line, internal hook skipped, no throw.
 *  - Performs NO durable I/O of its own (no analytics files, no body logging).
 *
 * This is the ONLY delivery-reporting surface extensions should use.
 */
export function reportOutboundDelivered(report: OutboundDeliveryReport): void {
  try {
    const now = Date.now();
    const key = idempotencyKey(report);
    if (alreadyReported(key, now)) {
      return;
    }
    if (!report.sessionKey) {
      log.debug(
        `reportOutboundDelivered: no sessionKey for ${report.channel} delivery to ${report.to}; ` +
          `internal message:sent hook skipped (plugin message_sent hook may still fire)`,
      );
    }
    const canonical = buildCanonicalSentMessageHookContext({
      to: report.to,
      content: report.content ?? "",
      success: report.success,
      error: report.error,
      channelId: report.channel,
      accountId: report.accountId,
      conversationId: report.to,
      sessionKey: report.sessionKey,
      messageId: report.messageId,
      isGroup: report.isGroup,
      groupId: report.groupId,
    });
    emitCanonicalMessageSent({
      canonical,
      sessionKeyForInternalHooks: report.sessionKey,
    });
  } catch (err) {
    // A reporting failure must never affect the delivery that already happened.
    try {
      log.warn(`reportOutboundDelivered failed (non-fatal): ${String(err)}`);
    } catch {
      /* ignore */
    }
  }
}

/** @internal test hook: reset the idempotency cache between unit tests. */
export function resetOutboundDeliveryReportCacheForTests(): void {
  seen.clear();
}

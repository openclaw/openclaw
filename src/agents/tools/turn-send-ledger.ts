/**
 * Per-turn, per-target outbound send ledger shared by the `message` and
 * `conversations_send` tools.
 *
 * The loop detector hashes full tool params (tool-loop-detection.ts), so a model
 * that re-sends the same answer with slightly reworded text produces a distinct
 * hash every time and is invisible to it. This ledger counts *successful*
 * deliveries per (turn, target) so a tool can nudge the model — or, when an
 * operator opts in, cap the fan-out — independently of the loop detector and its
 * default-off switch.
 *
 * State is module-level and keyed by agent session, mirroring the reviewed
 * `recentPollVoteBySession` precedent in message-tool.ts: a per-tool-instance
 * counter would be lost across the run boundary that separates the tool calls in
 * one turn, so the count must outlive the instance. A "turn" is one agent run
 * (`runId`); a slot resets when its `runId` changes, which bounds the counts to a
 * single turn without any explicit cleanup.
 */
import { normalizeAccountId } from "../../routing/account-id.js";
import { normalizeMessageChannel } from "../../utils/message-channel-normalize.js";

// A turn can span more tool round-trips than a poll echo, so this TTL is longer
// than POLL_VOTE_ECHO_TTL_MS; it only prunes sessions that went fully idle and
// keeps the single-slot map bounded in a long-lived gateway.
export const TURN_SEND_LEDGER_TTL_MS = 10 * 60_000;

type TurnSendSlot = {
  runId: string;
  counts: Map<string, number>;
  recordedAt: number;
};

// Single slot per session: the current turn's per-target counts.
const turnSendBySession = new Map<string, TurnSendSlot>();

type TurnSendKey = {
  sessionKey: string;
  runId: string;
  targetKey: string;
};

/**
 * Canonical per-turn ledger key `${channel}\0${account}\0${target}`, shared by the
 * `message` and `conversations_send` tools. Both must key on the same normalized
 * route so alternating the two tools at one real recipient can't evade the nudge or
 * the hard cap. Byte-identical to the route `resolveOutboundActionRoute` builds in
 * message-tool.ts (`normalizeAccountId(undefined)` folds to the "default" account).
 */
export function buildTurnSendTargetKey(params: {
  channel: string;
  accountId?: string;
  target: string;
}): string {
  return `${normalizeMessageChannel(params.channel)}\0${normalizeAccountId(params.accountId)}\0${params.target}`;
}

// A slot is live only within the TTL window measured from its last write. Peek and
// record share this predicate so they agree on what "expired" means: peek returns 0
// for an expired slot (dropping it), while record starts a fresh turn for one.
// Deliberate tradeoff: a >10-min-idle gap within a single turn resets that turn's
// budget. Accepted because the cap is a best-effort runaway-fan-out backstop, not a
// strict guarantee (see the module header).
function isLiveSlot(slot: TurnSendSlot, now: number): boolean {
  return now - slot.recordedAt <= TURN_SEND_LEDGER_TTL_MS;
}

/**
 * Records one successful send to `targetKey` in the current turn and returns the
 * running count (>= 1). A slot whose `runId` differs, or whose window has expired,
 * is treated as a new turn and its counts are cleared before recording. `now` is
 * injectable for deterministic tests; it defaults to the wall clock.
 */
export function recordTurnSend(
  { sessionKey, runId, targetKey }: TurnSendKey,
  now: number = Date.now(),
): number {
  pruneExpired(now);
  const existing = turnSendBySession.get(sessionKey);
  const slot: TurnSendSlot =
    existing && existing.runId === runId && isLiveSlot(existing, now)
      ? existing
      : { runId, counts: new Map<string, number>(), recordedAt: now };
  const next = (slot.counts.get(targetKey) ?? 0) + 1;
  slot.counts.set(targetKey, next);
  slot.recordedAt = now;
  turnSendBySession.set(sessionKey, slot);
  return next;
}

/**
 * Reads the current turn's send count for `targetKey` without incrementing it.
 * Returns 0 when the session has no slot, the slot belongs to a prior turn, or the
 * target has not been sent to yet — so a caller can gate the next send before
 * dispatch. `now` is injectable for deterministic tests; it defaults to the wall clock.
 *
 * An expired slot is pruned and treated as 0: otherwise a capped slot past its TTL
 * would keep returning its stale count and block forever, since the cap check runs
 * before recordTurnSend (the only other pruner) ever gets to reset it. Deleting the
 * one slot on peek is safe under single-threaded JS.
 *
 * The cap this gates is best-effort, not a strict concurrency guarantee: callers
 * peek, await the actual delivery, then recordTurnSend after it lands, so the
 * peek→await→record window is not atomic. Two tool calls racing on the same
 * target can each peek below the cap before either records, so both admit one
 * send. This bounds runaway fan-out without serializing concurrent sends.
 */
export function peekTurnSendCount(
  { sessionKey, runId, targetKey }: TurnSendKey,
  now: number = Date.now(),
): number {
  const slot = turnSendBySession.get(sessionKey);
  if (!slot || slot.runId !== runId) {
    return 0;
  }
  if (!isLiveSlot(slot, now)) {
    turnSendBySession.delete(sessionKey);
    return 0;
  }
  return slot.counts.get(targetKey) ?? 0;
}

export function resetTurnSendLedgerForTest(): void {
  turnSendBySession.clear();
}

function pruneExpired(now: number): void {
  for (const [key, slot] of turnSendBySession) {
    if (!isLiveSlot(slot, now)) {
      turnSendBySession.delete(key);
    }
  }
}

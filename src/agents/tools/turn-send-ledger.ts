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

// A turn can span more tool round-trips than a poll echo, so this TTL is longer
// than POLL_VOTE_ECHO_TTL_MS; it only prunes sessions that went fully idle and
// keeps the single-slot map bounded in a long-lived gateway.
const TURN_SEND_LEDGER_TTL_MS = 10 * 60_000;

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
 * Records one successful send to `targetKey` in the current turn and returns the
 * running count (>= 1). A slot whose `runId` differs is treated as a new turn and
 * its counts are cleared before recording.
 */
export function recordTurnSend({ sessionKey, runId, targetKey }: TurnSendKey): number {
  const now = Date.now();
  pruneExpired(now);
  const existing = turnSendBySession.get(sessionKey);
  const slot: TurnSendSlot =
    existing && existing.runId === runId
      ? existing
      : { runId, counts: new Map<string, number>(), recordedAt: now };
  const next = (slot.counts.get(targetKey) ?? 0) + 1;
  slot.counts.set(targetKey, next);
  slot.recordedAt = now;
  turnSendBySession.set(sessionKey, slot);
  return next;
}

/**
 * Reads the current turn's send count for `targetKey` without mutating the
 * ledger. Returns 0 when the session has no slot, the slot belongs to a prior
 * turn, or the target has not been sent to yet — so a caller can gate the next
 * send before dispatch.
 *
 * The cap this gates is best-effort, not a strict concurrency guarantee: callers
 * peek, await the actual delivery, then recordTurnSend after it lands, so the
 * peek→await→record window is not atomic. Two tool calls racing on the same
 * target can each peek below the cap before either records, so both admit one
 * send. This bounds runaway fan-out without serializing concurrent sends.
 */
export function peekTurnSendCount({ sessionKey, runId, targetKey }: TurnSendKey): number {
  const slot = turnSendBySession.get(sessionKey);
  if (!slot || slot.runId !== runId) {
    return 0;
  }
  return slot.counts.get(targetKey) ?? 0;
}

export function resetTurnSendLedgerForTest(): void {
  turnSendBySession.clear();
}

function pruneExpired(now: number): void {
  for (const [key, slot] of turnSendBySession) {
    if (now - slot.recordedAt > TURN_SEND_LEDGER_TTL_MS) {
      turnSendBySession.delete(key);
    }
  }
}

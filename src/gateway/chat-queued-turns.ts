/**
 * Gateway-owned cancel identity for turns that have been admitted to the
 * followup/collect queue but are not yet (or no longer) active chat-send runs.
 *
 * Active runs stay in chatAbortControllers. Queued waits must NOT look like
 * active runs (projection, timeout ownership, terminal dedupe), but they must
 * remain abortable by authorized requesters after chat.send terminalizes.
 */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { createAgentRunRestartAbortError } from "../agents/run-termination.js";
import { chatRunBelongsToAgent } from "./chat-run-owner.js";

export type QueuedChatTurnEntry = {
  controller: AbortController;
  sessionId: string;
  sessionKey: string;
  /** False once collect-mode transfers cancellation to the aggregate owner. */
  abortable?: boolean;
  abortListener?: () => void;
  agentId?: string;
  ownerConnId?: string;
  ownerDeviceId?: string;
  /** RunId of the follow-up turn that was admitted from this queue entry. */
  followupRunId?: string;
};

export type QueuedChatTurnMap = Map<string, QueuedChatTurnEntry>;

type RegisterQueuedChatTurnParams = {
  chatQueuedTurns: QueuedChatTurnMap;
  runId: string;
  controller: AbortController;
  sessionId: string;
  sessionKey: string;
  agentId?: string;
  ownerConnId?: string;
  ownerDeviceId?: string;
};

function resolveExactRunId(runId: string): string | undefined {
  // chat.send idempotency keys are exact protocol identities. Trimming here
  // would diverge from the active-run and dedupe registries.
  return runId.length > 0 ? runId : undefined;
}

function createQueuedChatAbortSignalReason(stopReason: string | undefined): Error | undefined {
  // Queued turns can outlive active registrations; their signal owns restart disposition.
  if (stopReason === "restart") {
    return createAgentRunRestartAbortError();
  }
  return stopReason ? new Error(`queued turn aborted: ${stopReason}`) : undefined;
}

function detachQueuedChatTurnAbortListener(entry: QueuedChatTurnEntry): void {
  // Queue settlement or collect transfer can precede the caller releasing its signal.
  if (entry.abortListener) {
    entry.controller.signal.removeEventListener("abort", entry.abortListener);
    entry.abortListener = undefined;
  }
}

// Queue callbacks can outlive their map entry, and protocol run IDs may be reused.
// Mutate only the exact entry captured by the callback or abort operation.
function deleteQueuedChatTurnEntry(
  chatQueuedTurns: QueuedChatTurnMap,
  runId: string,
  entry: QueuedChatTurnEntry,
): boolean {
  if (chatQueuedTurns.get(runId) !== entry) {
    return false;
  }
  detachQueuedChatTurnAbortListener(entry);
  return chatQueuedTurns.delete(runId);
}

export function registerQueuedChatTurn(params: RegisterQueuedChatTurnParams): boolean {
  const runId = resolveExactRunId(params.runId);
  const sessionKey = normalizeOptionalString(params.sessionKey);
  if (!runId || !sessionKey) {
    return false;
  }
  if (params.controller.signal.aborted) {
    return false;
  }
  const existing = params.chatQueuedTurns.get(runId);
  if (existing && existing.controller === params.controller) {
    return true;
  }
  if (existing) {
    return false;
  }
  const entry: QueuedChatTurnEntry = {
    controller: params.controller,
    sessionId: params.sessionId,
    sessionKey,
    agentId: normalizeOptionalString(params.agentId)?.toLowerCase(),
    ownerConnId: normalizeOptionalString(params.ownerConnId),
    ownerDeviceId: normalizeOptionalString(params.ownerDeviceId),
  };
  params.chatQueuedTurns.set(runId, entry);
  entry.abortListener = () => {
    // Retired collect entries remain idempotency guards until aggregate completion.
    if (entry.abortable !== false) {
      deleteQueuedChatTurnEntry(params.chatQueuedTurns, runId, entry);
    }
  };
  params.controller.signal.addEventListener("abort", entry.abortListener, { once: true });
  return true;
}

export function completeQueuedChatTurn(
  chatQueuedTurns: QueuedChatTurnMap,
  runId: string,
  controller: AbortController,
): boolean {
  const key = resolveExactRunId(runId);
  if (!key) {
    return false;
  }
  const entry = chatQueuedTurns.get(key);
  return entry?.controller === controller
    ? deleteQueuedChatTurnEntry(chatQueuedTurns, key, entry)
    : false;
}

/** Default TTL for retired follow-up runId mappings (5 minutes). */
export const RETIRED_FOLLOWUP_RUNID_TTL_MS = 5 * 60 * 1000;
/** Hard cap on the retired follow-up runId map size to bound process memory. */
export const RETIRED_FOLLOWUP_RUNID_MAX_SIZE = 4096;

/**
 * Retire a completed queued turn's follow-up runId so that subsequent
 * `agent.wait` terminal responses can still return it for client-side
 * correlation, even though the queue entry has been deleted.
 *
 * This handles the fast-completion race: if the follow-up completes between
 * identity polls, `completeQueuedChatTurn` deletes the entry before the
 * client discovers the ID. By preserving the mapping here, `waitForTurn`
 * includes `followupRunId` in the terminal snapshot response.
 *
 * Entries carry a TTL so the map cannot grow without bound across the
 * Gateway's lifetime; `pruneRetiredFollowupRunIds` is wired into the
 * periodic dedupe cleanup interval.
 */
export function retireFollowupRunId(
  retiredFollowupRunIds: Map<string, string>,
  runId: string,
  followupRunId: string | undefined,
): void {
  const key = resolveExactRunId(runId);
  if (!key || !followupRunId) {
    return;
  }
  retiredFollowupRunIds.set(key, followupRunId);
}

/**
 * Remove expired entries from the retired follow-up runId map. Entries older
 * than their inline `expiresAtMs` (or the whole map above `maxSize`) are
 * dropped so the map cannot accumulate stale identity mappings across the
 * Gateway lifetime. `ttlMs` is the historical TTL used when encoding
 * expiries; retained for call-site compatibility but expiry is inline.
 */
export function pruneRetiredFollowupRunIds(
  retiredFollowupRunIds: Map<string, string>,
  nowMs: number,
  _ttlMs = RETIRED_FOLLOWUP_RUNID_TTL_MS,
  maxSize = RETIRED_FOLLOWUP_RUNID_MAX_SIZE,
): void {
  if (retiredFollowupRunIds.size === 0) {
    return;
  }
  // Entries are stored as "followupRunId|expiresAtMs" to carry the TTL inline.
  const expired: string[] = [];
  for (const [key, value] of retiredFollowupRunIds) {
    const sep = value.lastIndexOf("|");
    if (sep === -1) {
      // Legacy/stale entry without a recorded expiry — drop it.
      expired.push(key);
      continue;
    }
    const expiresAtMs = Number(value.slice(sep + 1));
    if (Number.isFinite(expiresAtMs) && nowMs >= expiresAtMs) {
      expired.push(key);
    }
  }
  for (const key of expired) {
    retiredFollowupRunIds.delete(key);
  }
  if (retiredFollowupRunIds.size > maxSize) {
    const excess = retiredFollowupRunIds.size - maxSize;
    let removed = 0;
    for (const key of retiredFollowupRunIds.keys()) {
      if (removed >= excess) {
        break;
      }
      retiredFollowupRunIds.delete(key);
      removed += 1;
    }
  }
}

/**
 * Records the follow-up runId that was allocated for a queued turn, so that
 * subsequent `agent.wait` responses can return the expected follow-up identity
 * for secure client-side correlation.
 */
export function setQueuedChatTurnFollowupRunId(
  chatQueuedTurns: QueuedChatTurnMap,
  runId: string,
  controller: AbortController,
  followupRunId: string,
): boolean {
  const key = resolveExactRunId(runId);
  if (!key) {
    return false;
  }
  const entry = chatQueuedTurns.get(key);
  if (!entry || entry.controller !== controller) {
    return false;
  }
  entry.followupRunId = followupRunId;
  return true;
}

/**
 * Retain the live run identity for idempotency while transferring cancellation
 * to a collect aggregate. Completion still removes the entry.
 */
export function retireQueuedChatTurnCancellation(
  chatQueuedTurns: QueuedChatTurnMap,
  runId: string,
  controller: AbortController,
): boolean {
  const key = resolveExactRunId(runId);
  const entry = key ? chatQueuedTurns.get(key) : undefined;
  if (!entry || entry.controller !== controller) {
    return false;
  }
  entry.abortable = false;
  detachQueuedChatTurnAbortListener(entry);
  return true;
}

/**
 * Abort a single queued turn by runId. Does not authorize; caller must check.
 * Returns false when missing or already aborted/removed.
 */
export function abortQueuedChatTurnById(
  chatQueuedTurns: QueuedChatTurnMap,
  params: {
    runId: string;
    sessionKey: string;
    stopReason?: string;
    /** When true, allow abort even if sessionKey does not match (owner already authorized). */
    allowSessionMismatch?: boolean;
  },
): { aborted: boolean } {
  const runId = resolveExactRunId(params.runId);
  const sessionKey = normalizeOptionalString(params.sessionKey);
  if (!runId || !sessionKey) {
    return { aborted: false };
  }
  const entry = chatQueuedTurns.get(runId);
  if (!entry || entry.abortable === false) {
    return { aborted: false };
  }
  if (!params.allowSessionMismatch && entry.sessionKey !== sessionKey) {
    return { aborted: false };
  }
  if (!entry.controller.signal.aborted) {
    entry.controller.abort(createQueuedChatAbortSignalReason(params.stopReason));
  }
  deleteQueuedChatTurnEntry(chatQueuedTurns, runId, entry);
  return { aborted: true };
}

type QueuedChatTurnMatch = {
  runId: string;
  entry: QueuedChatTurnEntry;
};

/**
 * List queued turns matching session keys / session ids / optional agent scope.
 * Authorization is left to the caller.
 */
export function listQueuedChatTurnsForSession(params: {
  chatQueuedTurns: QueuedChatTurnMap;
  sessionKeys: Iterable<string>;
  sessionIds?: Iterable<string | undefined>;
  agentId?: string;
  defaultAgentId?: string;
}): QueuedChatTurnMatch[] {
  const sessionKeys = new Set(
    Array.from(params.sessionKeys, (k) => normalizeOptionalString(k)).filter((k): k is string =>
      Boolean(k),
    ),
  );
  const sessionIds = new Set(
    Array.from(params.sessionIds ?? [], (id) => normalizeOptionalString(id)).filter(
      (id): id is string => Boolean(id),
    ),
  );
  const agentId = normalizeOptionalString(params.agentId)?.toLowerCase();
  const defaultAgentId = normalizeOptionalString(params.defaultAgentId)?.toLowerCase();
  const matches: QueuedChatTurnMatch[] = [];
  for (const [runId, entry] of params.chatQueuedTurns) {
    if (entry.abortable === false) {
      continue;
    }
    if (!sessionKeys.has(entry.sessionKey) && !sessionIds.has(entry.sessionId)) {
      continue;
    }
    if (
      agentId &&
      !chatRunBelongsToAgent(
        {
          agentId: entry.agentId,
          sessionKey: entry.sessionKey,
          defaultAgentId,
        },
        agentId,
      )
    ) {
      continue;
    }
    matches.push({ runId, entry });
  }
  return matches;
}

/**
 * Abort all provided queued turns (already authorized by caller).
 * Order: abort signals first, then remove from map, so drain cannot promote mid-loop.
 */
export function abortQueuedChatTurns(
  chatQueuedTurns: QueuedChatTurnMap,
  matches: readonly QueuedChatTurnMatch[],
  stopReason?: string,
): string[] {
  const runIds: string[] = [];
  for (const { runId, entry } of matches) {
    if (chatQueuedTurns.get(runId) !== entry) {
      continue;
    }
    if (!entry.controller.signal.aborted) {
      entry.controller.abort(createQueuedChatAbortSignalReason(stopReason));
    }
    deleteQueuedChatTurnEntry(chatQueuedTurns, runId, entry);
    runIds.push(runId);
  }
  return runIds;
}

/**
 * Maps an agent session key to the **authenticated** gateway node that is
 * hosting/driving the turn for that session.
 *
 * When a turn is dispatched from a node-originated `agent.request` (the node is
 * authenticated to the gateway by a cryptographic device pairing), the gateway
 * records the originating `nodeId` against the session key here, just before
 * dispatch. The tool resolver reads it back to apply per-node tool restrictions
 * (`gateway.tools.byNode`).
 *
 * Unlike a self-declared `client.id`, the `nodeId` recorded here comes from the
 * node's authenticated connection — a client cannot forge it — so it is a sound
 * basis for *enforcing* (not merely advising) a reduced toolset. It remains
 * restriction-only: the node policy can only narrow the toolset, never escalate.
 *
 * Entries are bounded: each carries a timestamp, is honored only within a TTL
 * that comfortably outlasts a turn, and the map is capped (oldest evicted).
 */
const ENTRY_TTL_MS = 15 * 60_000;
const MAX_ENTRIES = 512;

type Entry = { nodeId: string; time: number };
const sessionKeyToNodeId = new Map<string, Entry>();

/** Record (or clear) the authenticated node hosting the next turn for a session. */
export function setSessionHostingNodeId(
  sessionKey: string,
  nodeId: string | undefined | null,
): void {
  const key = sessionKey.trim();
  if (!key) {
    return;
  }
  const normalized = typeof nodeId === "string" ? nodeId.trim() : "";
  if (!normalized) {
    sessionKeyToNodeId.delete(key);
    return;
  }
  sessionKeyToNodeId.set(key, { nodeId: normalized, time: Date.now() });
  if (sessionKeyToNodeId.size > MAX_ENTRIES) {
    for (const oldestKey of sessionKeyToNodeId.keys()) {
      sessionKeyToNodeId.delete(oldestKey);
      if (sessionKeyToNodeId.size <= MAX_ENTRIES) {
        break;
      }
    }
  }
}

/** Look up the authenticated node hosting a session, if any and still fresh. */
export function getSessionHostingNodeId(sessionKey: string): string | undefined {
  const key = sessionKey.trim();
  if (!key) {
    return undefined;
  }
  const entry = sessionKeyToNodeId.get(key);
  if (!entry) {
    return undefined;
  }
  if (Date.now() - entry.time >= ENTRY_TTL_MS) {
    sessionKeyToNodeId.delete(key);
    return undefined;
  }
  return entry.nodeId;
}

/** Test-only: reset the registry. */
export function resetSessionHostingNodeIdsForTest(): void {
  sessionKeyToNodeId.clear();
}

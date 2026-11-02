export type ChatRunToolRecipientState = {
  connIds: Set<string>;
  updatedAt: number;
  finalizedAt?: number;
};

export type ToolEventRecipientRegistry = ReturnType<typeof createToolEventRecipientRegistry>;

const TOOL_EVENT_RECIPIENT_TTL_MS = 10 * 60 * 1000;
const TOOL_EVENT_RECIPIENT_FINAL_GRACE_MS = 30 * 1000;

export function createToolEventRecipientRegistry(
  store: {
    runs: ReadonlyMap<string, { toolRecipient?: ChatRunToolRecipientState }>;
    getOrCreate: (runId: string) => { toolRecipient?: ChatRunToolRecipientState };
    releaseIfEmpty: (runId: string) => void;
  },
  isConnectionActive?: (connId: string) => boolean,
) {
  let nextPruneAt = Infinity;
  const pruneExpired = (now = Date.now()) => {
    if (now < nextPruneAt) {
      return;
    }
    nextPruneAt = Infinity;
    for (const [runId, record] of store.runs) {
      const entry = record.toolRecipient;
      if (!entry) {
        continue;
      }
      const cutoff = entry.finalizedAt
        ? entry.finalizedAt + TOOL_EVENT_RECIPIENT_FINAL_GRACE_MS
        : entry.updatedAt + TOOL_EVENT_RECIPIENT_TTL_MS;
      if (now >= cutoff) {
        delete record.toolRecipient;
        store.releaseIfEmpty(runId);
      } else {
        nextPruneAt = Math.min(nextPruneAt, cutoff);
      }
    }
  };

  const prune = (updated: ChatRunToolRecipientState) => {
    // Refreshes can move expiry later; a conservative lower bound avoids a
    // full run scan on each tool event while retaining exact expiry cleanup.
    nextPruneAt = Math.min(
      nextPruneAt,
      updated.finalizedAt
        ? updated.finalizedAt + TOOL_EVENT_RECIPIENT_FINAL_GRACE_MS
        : updated.updatedAt + TOOL_EVENT_RECIPIENT_TTL_MS,
    );
    pruneExpired();
  };

  const add = (runId: string, connId: string) => {
    if (!runId || !connId || isConnectionActive?.(connId) === false) {
      return;
    }
    const now = Date.now();
    const entry = (store.getOrCreate(runId).toolRecipient ??= {
      connIds: new Set<string>(),
      updatedAt: now,
    });
    entry.connIds.add(connId);
    entry.updatedAt = now;
    prune(entry);
  };

  const removeConnection = (connId: string) => {
    for (const [runId, record] of store.runs) {
      const entry = record.toolRecipient;
      if (entry?.connIds.delete(connId) && entry.connIds.size === 0) {
        delete record.toolRecipient;
        store.releaseIfEmpty(runId);
      }
    }
  };

  const get = (runId: string): ReadonlySet<string> | undefined => {
    const entry = store.runs.get(runId)?.toolRecipient;
    if (entry) {
      entry.updatedAt = Date.now();
      prune(entry);
    }
    // Pruning may retire this finalized run; never return its former audience.
    return store.runs.get(runId)?.toolRecipient?.connIds;
  };

  const markFinal = (runId: string) => {
    const entry = store.runs.get(runId)?.toolRecipient;
    if (!entry) {
      return;
    }
    entry.finalizedAt = Date.now();
    prune(entry);
  };

  return { add, removeConnection, get, markFinal, pruneExpired };
}

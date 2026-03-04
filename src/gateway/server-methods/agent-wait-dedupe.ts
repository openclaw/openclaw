import type { DedupeEntry } from "../server-shared.js";

export type AgentWaitTerminalSnapshot = {
  status: "ok" | "error" | "timeout";
  startedAt?: number;
  endedAt?: number;
  error?: string;
};

const AGENT_WAITERS_BY_RUN_ID = new Map<string, Set<() => void>>();

function parseRunIdFromDedupeKey(key: string): string | null {
  if (key.startsWith("agent:")) {
    return key.slice("agent:".length) || null;
  }
  if (key.startsWith("chat:")) {
    return key.slice("chat:".length) || null;
  }
  return null;
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function addWaiter(runId: string, waiter: () => void): () => void {
  const normalizedRunId = runId.trim();
  if (!normalizedRunId) {
    return () => {};
  }
  const existing = AGENT_WAITERS_BY_RUN_ID.get(normalizedRunId);
  if (existing) {
    existing.add(waiter);
    return () => {
      const waiters = AGENT_WAITERS_BY_RUN_ID.get(normalizedRunId);
      if (!waiters) {
        return;
      }
      waiters.delete(waiter);
      if (waiters.size === 0) {
        AGENT_WAITERS_BY_RUN_ID.delete(normalizedRunId);
      }
    };
  }
  AGENT_WAITERS_BY_RUN_ID.set(normalizedRunId, new Set([waiter]));
  return () => {
    const waiters = AGENT_WAITERS_BY_RUN_ID.get(normalizedRunId);
    if (!waiters) {
      return;
    }
    waiters.delete(waiter);
    if (waiters.size === 0) {
      AGENT_WAITERS_BY_RUN_ID.delete(normalizedRunId);
    }
  };
}

function notifyWaiters(runId: string): void {
  const normalizedRunId = runId.trim();
  if (!normalizedRunId) {
    return;
  }
  const waiters = AGENT_WAITERS_BY_RUN_ID.get(normalizedRunId);
  if (!waiters || waiters.size === 0) {
    return;
  }
  for (const waiter of waiters) {
    waiter();
  }
}

export function readTerminalSnapshotFromDedupeEntry(
  entry: DedupeEntry,
): AgentWaitTerminalSnapshot | null {
  const payload = entry.payload as
    | {
        status?: unknown;
        startedAt?: unknown;
        endedAt?: unknown;
        error?: unknown;
        summary?: unknown;
      }
    | undefined;
  const status = typeof payload?.status === "string" ? payload.status : undefined;
  if (status === "accepted" || status === "started" || status === "in_flight") {
    return null;
  }

  const startedAt = asFiniteNumber(payload?.startedAt);
  const endedAt = asFiniteNumber(payload?.endedAt) ?? entry.ts;
  const errorMessage =
    typeof payload?.error === "string"
      ? payload.error
      : typeof payload?.summary === "string"
        ? payload.summary
        : entry.error?.message;

  if (status === "ok" || status === "timeout") {
    return {
      status,
      startedAt,
      endedAt,
      error: status === "timeout" ? errorMessage : undefined,
    };
  }
  if (status === "error" || !entry.ok) {
    return {
      status: "error",
      startedAt,
      endedAt,
      error: errorMessage,
    };
  }
  return null;
}

export function readTerminalSnapshotFromGatewayDedupe(params: {
  dedupe: Map<string, DedupeEntry>;
  runId: string;
}): AgentWaitTerminalSnapshot | null {
  const agentEntry = params.dedupe.get(`agent:${params.runId}`);
  const agentSnapshot = agentEntry ? readTerminalSnapshotFromDedupeEntry(agentEntry) : null;
  if (agentEntry) {
    if (!agentSnapshot) {
      // If an agent run has an in-flight dedupe entry, never fall back to any
      // stale chat dedupe record for the same run id.
      return null;
    }
  }

  const chatEntry = params.dedupe.get(`chat:${params.runId}`);
  const chatSnapshot = chatEntry ? readTerminalSnapshotFromDedupeEntry(chatEntry) : null;

  if (agentSnapshot && chatSnapshot && agentEntry && chatEntry) {
    // Reused idempotency keys can leave both records present. Prefer the
    // freshest terminal snapshot so callers observe the latest run outcome.
    return chatEntry.ts > agentEntry.ts ? chatSnapshot : agentSnapshot;
  }

  return agentSnapshot ?? chatSnapshot;
}

export async function waitForTerminalGatewayDedupe(params: {
  dedupe: Map<string, DedupeEntry>;
  runId: string;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<AgentWaitTerminalSnapshot | null> {
  const initial = readTerminalSnapshotFromGatewayDedupe(params);
  if (initial) {
    return initial;
  }
  if (params.timeoutMs <= 0 || params.signal?.aborted) {
    return null;
  }

  return await new Promise((resolve) => {
    let settled = false;
    let timeoutHandle: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;
    let removeWaiter: (() => void) | undefined;

    const finish = (snapshot: AgentWaitTerminalSnapshot | null) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      if (onAbort) {
        params.signal?.removeEventListener("abort", onAbort);
      }
      removeWaiter?.();
      resolve(snapshot);
    };

    const onWake = () => {
      const snapshot = readTerminalSnapshotFromGatewayDedupe(params);
      if (snapshot) {
        finish(snapshot);
      }
    };

    removeWaiter = addWaiter(params.runId, onWake);
    onWake();
    if (settled) {
      return;
    }

    const timeoutDelayMs = Math.max(1, Math.min(Math.floor(params.timeoutMs), 2_147_483_647));
    timeoutHandle = setTimeout(() => finish(null), timeoutDelayMs);
    timeoutHandle.unref?.();

    onAbort = () => finish(null);
    params.signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function setGatewayDedupeEntry(params: {
  dedupe: Map<string, DedupeEntry>;
  key: string;
  entry: DedupeEntry;
}) {
  params.dedupe.set(params.key, params.entry);
  const runId = parseRunIdFromDedupeKey(params.key);
  if (!runId) {
    return;
  }
  const snapshot = readTerminalSnapshotFromDedupeEntry(params.entry);
  if (!snapshot) {
    return;
  }
  notifyWaiters(runId);
}

export const __testing = {
  getWaiterCount(runId?: string): number {
    if (runId) {
      return AGENT_WAITERS_BY_RUN_ID.get(runId)?.size ?? 0;
    }
    let total = 0;
    for (const waiters of AGENT_WAITERS_BY_RUN_ID.values()) {
      total += waiters.size;
    }
    return total;
  },
  resetWaiters() {
    AGENT_WAITERS_BY_RUN_ID.clear();
  },
};

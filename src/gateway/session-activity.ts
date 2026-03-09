export type SessionActivityPhase = "idle" | "queued" | "running";

export type SessionActivitySource = "chat" | "heartbeat" | "cron";

export type SessionActivityEntry = {
  key: string;
  phase: SessionActivityPhase;
  source: SessionActivitySource | null;
  runId?: string;
  startedAt?: number;
  lastActivityAt?: number;
};

type ActiveSessionRun = {
  sessionKey: string;
  runId: string;
  source: SessionActivitySource;
  startedAt: number;
  lastActivityAt: number;
};

export type SessionActivityRegistry = {
  markRunStarted: (entry: {
    sessionKey: string;
    runId: string;
    source: SessionActivitySource;
    startedAt?: number;
  }) => void;
  touchRun: (runId: string, at?: number) => void;
  markRunFinished: (runId: string) => void;
  getRunning: (sessionKey: string) => SessionActivityEntry | null;
  listActiveSessionKeys: () => string[];
  clear: () => void;
};

function compareRuns(a: ActiveSessionRun, b: ActiveSessionRun) {
  if (a.lastActivityAt !== b.lastActivityAt) {
    return b.lastActivityAt - a.lastActivityAt;
  }
  if (a.startedAt !== b.startedAt) {
    return b.startedAt - a.startedAt;
  }
  return a.runId.localeCompare(b.runId);
}

export function createSessionActivityRegistry(): SessionActivityRegistry {
  const runsById = new Map<string, ActiveSessionRun>();
  const runIdsBySession = new Map<string, Set<string>>();

  const removeRunIdFromSession = (sessionKey: string, runId: string) => {
    const sessionRuns = runIdsBySession.get(sessionKey);
    if (!sessionRuns) {
      return;
    }
    sessionRuns.delete(runId);
    if (sessionRuns.size === 0) {
      runIdsBySession.delete(sessionKey);
    }
  };

  return {
    markRunStarted: ({ sessionKey, runId, source, startedAt }) => {
      const normalizedSessionKey = sessionKey.trim();
      const normalizedRunId = runId.trim();
      if (!normalizedSessionKey || !normalizedRunId) {
        return;
      }
      const now = Number.isFinite(startedAt) ? Math.max(0, startedAt ?? 0) : Date.now();
      const existing = runsById.get(normalizedRunId);
      if (existing && existing.sessionKey !== normalizedSessionKey) {
        removeRunIdFromSession(existing.sessionKey, normalizedRunId);
      }
      runsById.set(normalizedRunId, {
        sessionKey: normalizedSessionKey,
        runId: normalizedRunId,
        source,
        startedAt: existing?.startedAt ?? now,
        lastActivityAt: now,
      });
      let sessionRuns = runIdsBySession.get(normalizedSessionKey);
      if (!sessionRuns) {
        sessionRuns = new Set<string>();
        runIdsBySession.set(normalizedSessionKey, sessionRuns);
      }
      sessionRuns.add(normalizedRunId);
    },
    touchRun: (runId, at) => {
      const existing = runsById.get(runId);
      if (!existing) {
        return;
      }
      existing.lastActivityAt = Number.isFinite(at) ? Math.max(0, at ?? 0) : Date.now();
    },
    markRunFinished: (runId) => {
      const existing = runsById.get(runId);
      if (!existing) {
        return;
      }
      runsById.delete(runId);
      removeRunIdFromSession(existing.sessionKey, runId);
    },
    getRunning: (sessionKey) => {
      const sessionRuns = runIdsBySession.get(sessionKey);
      if (!sessionRuns || sessionRuns.size === 0) {
        return null;
      }
      const best = [...sessionRuns]
        .map((runId) => runsById.get(runId))
        .filter((entry): entry is ActiveSessionRun => Boolean(entry))
        .toSorted(compareRuns)[0];
      if (!best) {
        return null;
      }
      return {
        key: sessionKey,
        phase: "running",
        source: best.source,
        runId: best.runId,
        startedAt: best.startedAt,
        lastActivityAt: best.lastActivityAt,
      };
    },
    listActiveSessionKeys: () => [...runIdsBySession.keys()].toSorted(),
    clear: () => {
      runsById.clear();
      runIdsBySession.clear();
    },
  };
}

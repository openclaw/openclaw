import { formatErrorMessage as formatError } from "../../infra/errors.js";
import { resolveGlobalMap } from "../../shared/global-singleton.js";
import {
  prepareClientVoiceSessionClose,
  withClientVoiceSessionSettlement,
} from "../../talk/client-voice-session-lifecycle.js";
import type { PreparedTalkSessionTarget } from "./session-target.types.js";

type TalkConnectionCleanupKind =
  | "browser-control"
  | "realtime-relay"
  | "transcription-relay"
  | "voice-selection";

type UnifiedTalkSessionRecord =
  | {
      kind: "realtime-relay";
      connId: string;
      relaySessionId: string;
      sessionTarget: PreparedTalkSessionTarget;
    }
  | {
      kind: "transcription-relay";
      connId: string;
      transcriptionSessionId: string;
    }
  | {
      kind: "managed-room";
      handoffId: string;
      roomId: string;
    };

const unifiedTalkSessions = resolveGlobalMap<string, UnifiedTalkSessionRecord>(
  Symbol.for("openclaw.unifiedTalkSessions"),
  "close-and-restart",
);
type TalkConnectionCleanup = {
  run: () => void | Promise<void>;
  nextRun?: () => void | Promise<void>;
  pending?: Promise<void>;
  failed: boolean;
};

const talkConnectionCleanups = resolveGlobalMap<
  string,
  Map<TalkConnectionCleanupKind, TalkConnectionCleanup>
>(
  Symbol.for("openclaw.talkConnectionCleanups"),
  async (connections) => {
    const results = await Promise.allSettled(
      [...connections].flatMap(([connId, cleanups]) =>
        [...cleanups].map(async ([kind, cleanup]) => {
          await runTalkConnectionCleanup(connId, kind, cleanup);
        }),
      ),
    );
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (failures.length > 0) {
      throw new AggregateError(failures, "Talk provider cleanup did not complete");
    }
  },
  "close-and-restart",
);

function runTalkConnectionCleanup(
  connId: string,
  kind: TalkConnectionCleanupKind,
  cleanup: TalkConnectionCleanup,
): Promise<void> {
  if (cleanup.pending) {
    return cleanup.pending;
  }
  if (talkConnectionCleanups.get(connId)?.get(kind) !== cleanup) {
    return Promise.resolve();
  }
  // One promise owns callback execution and its shutdown join, including synchronous callbacks.
  cleanup.pending = Promise.resolve()
    .then(cleanup.run)
    .then(
      () => {
        cleanup.pending = undefined;
        cleanup.failed = false;
        const cleanups = talkConnectionCleanups.get(connId);
        if (cleanups?.get(kind) === cleanup) {
          if (cleanup.nextRun) {
            cleanup.run = cleanup.nextRun;
            cleanup.nextRun = undefined;
            return runTalkConnectionCleanup(connId, kind, cleanup);
          }
          cleanups.delete(kind);
          if (cleanups.size === 0 && talkConnectionCleanups.get(connId) === cleanups) {
            talkConnectionCleanups.delete(connId);
          }
        }
      },
      (error: unknown) => {
        cleanup.pending = undefined;
        cleanup.failed = true;
        throw error;
      },
    );
  return cleanup.pending;
}

/** Keeps failed cleanup under its original owner until a successful retry. */
export function registerTalkConnectionCleanup(
  connId: string,
  kind: TalkConnectionCleanupKind,
  cleanup: () => void | Promise<void>,
): void {
  const cleanups =
    talkConnectionCleanups.get(connId) ??
    new Map<TalkConnectionCleanupKind, TalkConnectionCleanup>();
  const previous = cleanups.get(kind);
  // Each kind scans its live sessions; retain a failed original before the latest replacement.
  if (previous?.pending || previous?.failed) {
    previous.nextRun = cleanup;
  } else {
    cleanups.set(kind, { run: cleanup, failed: false });
  }
  talkConnectionCleanups.set(connId, cleanups);
}

/** Starts cleanup without blocking the socket callback and reports asynchronous failures. */
export function cleanupTalkConnection(
  connId: string,
  log: { warn: (message: string) => void },
): void {
  const cleanups = talkConnectionCleanups.get(connId);
  if (!cleanups) {
    return;
  }
  // Snapshot owners because callbacks can remove or replace cleanup kinds.
  const snapshot = [...cleanups];
  for (const [kind, cleanup] of snapshot) {
    if (cleanup.pending) {
      continue;
    }
    const report = (error: unknown) => {
      log.warn(
        `failed to run ${kind} Talk cleanup after connection disconnect: ${formatError(error)}`,
      );
    };
    void runTalkConnectionCleanup(connId, kind, cleanup).catch(report);
  }
}

export function prepareTalkConnectionClose(
  clients: Iterable<{ connId: string }>,
  log: { warn: (message: string) => void },
) {
  const persistence = prepareClientVoiceSessionClose();
  let pending: Promise<void> | undefined;
  const beginClose = () => {
    if (pending) {
      return;
    }
    // Provider close can emit final speech. Retain this Gateway's cleanup before
    // fencing admission; sibling Gateways keep their own connections and claims.
    const connIds = Array.from(clients, (client) => client.connId);
    const cleanup = () => closeTalkConnections(connIds);
    pending = withClientVoiceSessionSettlement(cleanup, async (error) => {
      try {
        await cleanup();
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "Talk cleanup failed", {
          cause: cleanupError,
        });
      }
      throw error;
    });
    void pending.catch((error: unknown) => log.warn(`Talk cleanup failed: ${formatError(error)}`));
    persistence.beginClose();
  };
  return {
    beginClose,
    async drain() {
      try {
        beginClose();
        await pending;
      } finally {
        await persistence.drain();
      }
    },
  };
}

async function closeTalkConnections(connIds: Iterable<string>): Promise<void> {
  const pending: Promise<void>[] = [];
  for (const connId of connIds) {
    const cleanups = [...(talkConnectionCleanups.get(connId) ?? [])];
    for (const [kind, cleanup] of cleanups) {
      pending.push(runTalkConnectionCleanup(connId, kind, cleanup));
    }
  }
  const results = await Promise.allSettled(pending);
  const failures = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (failures.length > 0) {
    throw new AggregateError(failures, "Talk provider cleanup did not complete");
  }
}

export function rememberUnifiedTalkSession(
  sessionId: string,
  session: UnifiedTalkSessionRecord,
): void {
  unifiedTalkSessions.set(sessionId, session);
}

export function getUnifiedTalkSession(sessionId: string): UnifiedTalkSessionRecord {
  const session = unifiedTalkSessions.get(sessionId);
  if (!session) {
    throw new Error("Unknown Talk session");
  }
  return session;
}

/** Retains the realtime relay's admitted target without reinterpreting current defaults. */
export function resolveUnifiedTalkSessionTarget(sessionId: string, connId: string | undefined) {
  const session = unifiedTalkSessions.get(sessionId);
  if (session?.kind !== "realtime-relay") {
    return undefined;
  }
  requireUnifiedTalkSessionConn(session, connId);
  const target = session.sessionTarget;
  return {
    target,
    isCurrent: () =>
      unifiedTalkSessions.get(sessionId) === session &&
      session.connId === connId &&
      session.sessionTarget === target,
  };
}

export function forgetUnifiedTalkSession(sessionId: string): void {
  unifiedTalkSessions.delete(sessionId);
}

export function requireUnifiedTalkSessionConn(
  session: Extract<UnifiedTalkSessionRecord, { connId: string }>,
  connId: string | undefined,
): string {
  if (!connId || session.connId !== connId) {
    throw new Error("Talk session is not owned by this connection");
  }
  return connId;
}

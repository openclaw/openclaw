import type { EngineConnection } from "../../infra/sql-connection.js";
import { deferSqlitePostCommitPublication } from "../../infra/sqlite-post-commit.js";
import { resolveGlobalMap } from "../../shared/global-singleton.js";
import { required, type WorkerSessionPlacementRecord } from "./placement-record.js";

type TurnClaimReleaseWaiter = (error?: Error) => void;

const turnClaimReleaseWaiters = resolveGlobalMap<string, Map<string, Set<TurnClaimReleaseWaiter>>>(
  Symbol.for("openclaw.turnClaimReleaseWaiters"),
  (waitersByPath) => {
    const error = new Error("Gateway lifecycle ended while waiting for turn claim release");
    for (const bySession of waitersByPath.values()) {
      for (const waiters of bySession.values()) {
        for (const reject of waiters) {
          reject(error);
        }
      }
    }
    waitersByPath.clear();
  },
);

function waitersFor(path: string, sessionId: string): Set<TurnClaimReleaseWaiter> {
  let bySession = turnClaimReleaseWaiters.get(path);
  if (!bySession) {
    bySession = new Map();
    turnClaimReleaseWaiters.set(path, bySession);
  }
  let waiters = bySession.get(sessionId);
  if (!waiters) {
    waiters = new Set();
    bySession.set(sessionId, waiters);
  }
  return waiters;
}

export function signalTurnClaimRelease(path: string, sessionId: string): void {
  const bySession = turnClaimReleaseWaiters.get(path);
  const waiters = bySession?.get(sessionId);
  if (!bySession || !waiters) {
    return;
  }
  bySession.delete(sessionId);
  if (bySession.size === 0) {
    turnClaimReleaseWaiters.delete(path);
  }
  for (const resolve of waiters) {
    resolve();
  }
}

function removeTurnClaimReleaseWaiter(
  path: string,
  sessionId: string,
  waiter: TurnClaimReleaseWaiter,
): void {
  const bySession = turnClaimReleaseWaiters.get(path);
  const waiters = bySession?.get(sessionId);
  if (!bySession || !waiters) {
    return;
  }
  waiters.delete(waiter);
  if (waiters.size === 0) {
    bySession.delete(sessionId);
  }
  if (bySession.size === 0) {
    turnClaimReleaseWaiters.delete(path);
  }
}

export function deferTurnClaimRelease(db: EngineConnection, path: string, sessionId: string): void {
  if (!deferSqlitePostCommitPublication(db, () => signalTurnClaimRelease(path, sessionId))) {
    throw new Error("Worker turn release requires its owning transaction");
  }
}

/** Register before the worker read so a release cannot be lost while the read is pending. */
export function waitForPlacementTurnClaimRelease(
  path: string,
  sessionIdInput: string,
  options: { timeoutMs?: number; signal?: AbortSignal },
  read: (sessionId: string) => Promise<WorkerSessionPlacementRecord | undefined>,
): Promise<void> {
  const sessionId = required(sessionIdInput, "session id");
  if (
    options.timeoutMs !== undefined &&
    (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 0)
  ) {
    return Promise.reject(
      new Error("Worker session turn claim wait timeout must be a non-negative integer"),
    );
  }
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      removeTurnClaimReleaseWaiter(path, sessionId, finish);
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };
    const onAbort = () => finish(new Error(`Turn claim wait aborted for session ${sessionId}`));
    waitersFor(path, sessionId).add(finish);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) {
      onAbort();
      return;
    }
    if (options.timeoutMs !== undefined) {
      timer = setTimeout(
        () => finish(new Error(`Timed out waiting for session ${sessionId} turn claim release`)),
        options.timeoutMs,
      );
    }
    void read(sessionId).then(
      (placement) => {
        if (!placement?.turnClaim) {
          finish();
        }
      },
      (error: unknown) => finish(error instanceof Error ? error : new Error(String(error))),
    );
  });
}

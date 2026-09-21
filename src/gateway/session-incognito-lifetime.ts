import { AsyncLocalStorage } from "node:async_hooks";
import type { DatabaseSync } from "node:sqlite";
import { getGatewayRestartDrainSignal } from "../process/gateway-work-admission.js";
import { onSessionIdentityMutation } from "../sessions/session-lifecycle-events.js";
import { sessionChanges, type SessionRowChange } from "../sessions/session-row-changes.js";
import {
  INCOGNITO_SESSION_LIFETIME_MS,
  isIncognitoSessionKey,
} from "../shared/incognito-session-key.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import type { GatewayPostReadySidecarHandle } from "./server-startup-sidecar-scheduler.js";

const CLEANUP_RETRY_MS = 60_000;

/** Deadline scheduling only: the session deletion owner drains work and removes data. */
export function startIncognitoSessionLifetime(params: {
  context: GatewayRequestContext;
  logWarning: (message: string) => void;
}): GatewayPostReadySidecarHandle {
  type Deadline = {
    sessionKey: string;
    agentId: string;
    storePath: string;
    sessionId: string;
    source: Pick<DatabaseSync, "isOpen">;
    expiresAt: number;
    timer?: ReturnType<typeof setTimeout>;
  };
  const runInOwner = AsyncLocalStorage.snapshot();
  const restartSignal = getGatewayRestartDrainSignal();
  const deadlines = new Map<string, Deadline>();
  const pending = new Set<Promise<void>>();
  let stopped = false;

  const current = (deadline: Deadline) =>
    !stopped &&
    !restartSignal.aborted &&
    deadlines.get(deadline.sessionKey) === deadline &&
    deadline.source.isOpen;

  const retire = (deadline: Deadline) => {
    if (deadline.timer) {
      clearTimeout(deadline.timer);
    }
    if (deadlines.get(deadline.sessionKey) === deadline) {
      deadlines.delete(deadline.sessionKey);
    }
  };

  const schedule = (deadline: Deadline, delay = deadline.expiresAt - Date.now()) => {
    deadline.timer = setTimeout(
      () => {
        deadline.timer = undefined;
        if (!current(deadline)) {
          retire(deadline);
          return;
        }
        const operation = (async () => {
          try {
            const { deleteGatewaySession } = await import("./server-methods/sessions-delete.js");
            const result = await deleteGatewaySession({
              params: {
                key: deadline.sessionKey,
                agentId: deadline.agentId,
                expectedSessionId: deadline.sessionId,
              },
              client: null,
              context: params.context,
              assertCurrent: () => {
                if (!current(deadline)) {
                  throw new Error("Incognito expiry no longer owns this session.");
                }
              },
            });
            if (!result.ok) {
              throw new Error(result.error.message);
            }
            retire(deadline);
          } catch {
            if (current(deadline)) {
              params.logWarning("Incognito session expiry could not finish cleanup; will retry.");
              schedule(deadline, CLEANUP_RETRY_MS);
            } else {
              retire(deadline);
            }
          }
        })();
        pending.add(operation);
        void operation.finally(() => pending.delete(operation));
      },
      Math.max(0, delay),
    );
    deadline.timer.unref?.();
  };

  const observe = (change: SessionRowChange) => {
    if (stopped || restartSignal.aborted || !("sessionKey" in change)) {
      return;
    }
    const { sessionKey, agentId, storePath, incognitoEntry: entry } = change;
    if (!isIncognitoSessionKey(sessionKey) || !agentId || !storePath || !entry) {
      return;
    }
    const existing = deadlines.get(sessionKey);
    if (existing && existing.source === entry.source && existing.sessionId === entry.sessionId) {
      // Activity, archive, rewind, and metadata edits never renew a lifetime.
      return;
    }
    if (existing) {
      retire(existing);
    }
    if (!entry.source.isOpen) {
      return;
    }
    const deadline: Deadline = {
      sessionKey,
      agentId,
      storePath,
      sessionId: entry.sessionId,
      source: entry.source,
      expiresAt: (entry.createdAt ?? Date.now()) + INCOGNITO_SESSION_LIFETIME_MS,
    };
    deadlines.set(sessionKey, deadline);
    schedule(deadline);
  };

  const unsubscribe = sessionChanges.subscribeProjection((change) =>
    runInOwner(() => observe(change)),
  );
  const unsubscribeIdentity = onSessionIdentityMutation((mutation) => {
    for (const key of mutation.previous.sessionKeys) {
      const deadline = deadlines.get(key);
      if (
        deadline &&
        deadline.sessionId === mutation.previous.sessionId &&
        !(
          "current" in mutation &&
          mutation.current.sessionId === deadline.sessionId &&
          mutation.current.sessionKeys.includes(key)
        )
      ) {
        retire(deadline);
      }
    }
  });
  return {
    stop: async () => {
      stopped = true;
      unsubscribe();
      unsubscribeIdentity();
      for (const deadline of deadlines.values()) {
        retire(deadline);
      }
      await Promise.all(pending);
    },
  };
}

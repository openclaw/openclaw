import { AsyncLocalStorage } from "node:async_hooks";
import type { DatabaseSync } from "node:sqlite";
import { resolveStateDir } from "../config/paths.js";
import {
  listSessionEntriesReadOnly,
  loadSessionEntryReadOnly,
} from "../config/sessions/session-accessor.js";
import { getGatewayRestartDrainSignal } from "../process/gateway-work-admission.js";
import { sessionChanges, type SessionRowChange } from "../sessions/session-row-changes.js";
import {
  INCOGNITO_SESSION_LIFETIME_MS,
  isIncognitoSessionKey,
} from "../shared/incognito-session-key.js";
import {
  getOpenClawAgentDatabaseIfOpen,
  listOpenIncognitoAgentDatabases,
  resolveIncognitoOpenClawAgentSqlitePath,
} from "../state/openclaw-agent-db.js";
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
  const env = { ...process.env, OPENCLAW_STATE_DIR: resolveStateDir() };
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
    if (
      !isIncognitoSessionKey(sessionKey) ||
      !agentId ||
      storePath !== resolveIncognitoOpenClawAgentSqlitePath({ agentId, env })
    ) {
      return;
    }
    const existing = deadlines.get(sessionKey);
    if (!entry) {
      // Metadata-only and deletion publications both omit entry facts. Read only
      // this process-held key to distinguish them, never scan or open a store.
      if (
        existing &&
        (!existing.source.isOpen ||
          loadSessionEntryReadOnly({ agentId, sessionKey, storePath, env })?.sessionId !==
            existing.sessionId)
      ) {
        retire(existing);
      }
      return;
    }
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
  // A sibling Gateway can start after creation and outlive the first scheduler.
  // Hydrate only this owner's already-open memory stores, then follow publications.
  for (const target of listOpenIncognitoAgentDatabases()) {
    if (target.storePath !== resolveIncognitoOpenClawAgentSqlitePath({ ...target, env })) {
      continue;
    }
    const database = getOpenClawAgentDatabaseIfOpen({
      agentId: target.agentId,
      path: target.storePath,
      env,
    });
    if (!database) {
      continue;
    }
    for (const { sessionKey, entry } of listSessionEntriesReadOnly({
      ...target,
      env,
      clone: false,
    })) {
      observe({
        ...target,
        sessionKey,
        incognitoEntry: {
          sessionId: entry.sessionId,
          createdAt: entry.createdAt,
          source: database.db,
        },
      });
    }
  }
  return {
    stop: async () => {
      stopped = true;
      unsubscribe();
      for (const deadline of deadlines.values()) {
        retire(deadline);
      }
      await Promise.all(pending);
    },
  };
}

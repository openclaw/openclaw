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
  resolveIncognitoSessionExpiresAt,
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
    const { sessionKey, agentId, storePath } = change;
    if (
      !isIncognitoSessionKey(sessionKey) ||
      !agentId ||
      storePath !== resolveIncognitoOpenClawAgentSqlitePath({ agentId, env })
    ) {
      return;
    }
    const existing = deadlines.get(sessionKey);
    // Projection observers run after committed facts settle. Resolve only this
    // owner's already-open connection and exact key; never admit a store here.
    const database = getOpenClawAgentDatabaseIfOpen({ agentId, path: storePath, env });
    const entry = database
      ? loadSessionEntryReadOnly({ agentId, sessionKey, storePath, env })
      : undefined;
    if (!database || !entry) {
      if (existing) {
        retire(existing);
      }
      return;
    }
    if (existing && existing.source === database.db && existing.sessionId === entry.sessionId) {
      // Activity, archive, rewind, and metadata edits never renew a lifetime.
      return;
    }
    if (existing) {
      retire(existing);
    }
    const expiresAt = resolveIncognitoSessionExpiresAt(entry);
    if (!database.db.isOpen || expiresAt === undefined) {
      return;
    }
    const deadline: Deadline = {
      sessionKey,
      agentId,
      storePath,
      sessionId: entry.sessionId,
      source: database.db,
      expiresAt,
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
    for (const { sessionKey } of listSessionEntriesReadOnly({ ...target, env, clone: false })) {
      observe({ ...target, sessionKey });
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

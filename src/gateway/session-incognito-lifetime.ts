import { AsyncLocalStorage } from "node:async_hooks";
import { resolveStateDir } from "../config/paths.js";
import {
  listSessionEntriesReadOnly,
  loadSessionEntryReadOnly,
} from "../config/sessions/session-accessor.js";
import type { GatewayScheduler, GatewayScheduledJob } from "../infra/gateway-scheduler.js";
import { getGatewayRestartDrainSignal } from "../process/gateway-work-admission.js";
import { sessionChanges, type SessionRowChange } from "../sessions/session-row-changes.js";
import {
  resolveIncognitoSessionExpiresAt,
  isIncognitoSessionKey,
} from "../shared/incognito-session-key.js";
import { readOpenClawAgentDatabaseIdentity } from "../state/openclaw-agent-db-identity.js";
import {
  getOpenClawAgentDatabaseIfOpen,
  listOpenIncognitoAgentDatabases,
  resolveIncognitoOpenClawAgentSqlitePath,
} from "../state/openclaw-agent-db.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import type { GatewayPostReadySidecarHandle } from "./server-startup-sidecar-scheduler.js";

const CLEANUP_RETRY_MS = 60_000;

type IncognitoSessionDeadline = {
  sessionKey: string;
  agentId: string;
  sessionId: string;
  expiresAt: number;
  source: { identity: string | symbol; assertCurrent(): void };
};

type DeleteIncognitoSession = (
  deadline: IncognitoSessionDeadline,
  assertCurrent: () => void,
) => Promise<void>;

/** Deadline scheduling only: the session deletion owner drains work and removes data. */
function createIncognitoSessionDeadlineOwner(params: {
  logWarning: (message: string) => void;
  scheduler: GatewayScheduler;
  deleteSession: DeleteIncognitoSession;
}) {
  type Deadline = IncognitoSessionDeadline & { job?: GatewayScheduledJob };
  const scheduler = params.scheduler.scope();
  const restartSignal = getGatewayRestartDrainSignal();
  const deadlines = new Map<string, Deadline>();
  const current = (deadline: Deadline) => {
    if (
      scheduler.signal.aborted ||
      restartSignal.aborted ||
      deadlines.get(deadline.sessionKey) !== deadline
    ) {
      return false;
    }
    try {
      deadline.source.assertCurrent();
      return true;
    } catch {
      return false;
    }
  };

  const retire = (deadline: Deadline) => {
    deadline.job?.cancel();
    if (deadlines.get(deadline.sessionKey) === deadline) {
      deadlines.delete(deadline.sessionKey);
    }
  };

  const schedule = (deadline: Deadline, delayMs?: number) => {
    deadline.job = scheduler.schedule({
      id: `incognito-expiry:${deadline.sessionKey}`,
      ...(delayMs === undefined ? { atMs: deadline.expiresAt } : { delayMs }),
      run: async () => {
        if (!current(deadline)) {
          retire(deadline);
          return;
        }
        let accepted = true;
        try {
          await params.deleteSession(deadline, () => {
            if (!accepted || !current(deadline)) {
              throw new Error("Incognito expiry no longer owns this session.");
            }
          });
          retire(deadline);
        } catch {
          if (current(deadline)) {
            params.logWarning("Incognito session expiry could not finish cleanup; will retry.");
            schedule(deadline, CLEANUP_RETRY_MS);
          } else {
            retire(deadline);
          }
        } finally {
          accepted = false;
        }
      },
    });
  };

  return {
    observe(fact: IncognitoSessionDeadline) {
      if (scheduler.signal.aborted || restartSignal.aborted) {
        return;
      }
      fact.source.assertCurrent();
      const existing = deadlines.get(fact.sessionKey);
      if (
        existing?.source.identity === fact.source.identity &&
        existing.sessionId === fact.sessionId
      ) {
        // Activity, archive, rewind, and metadata edits never renew a lifetime.
        return;
      }
      if (existing) {
        retire(existing);
      }
      const deadline: Deadline = { ...fact };
      deadlines.set(fact.sessionKey, deadline);
      schedule(deadline);
    },
    forget(sessionKey: string) {
      const existing = deadlines.get(sessionKey);
      if (existing) {
        retire(existing);
      }
    },
    stop: async () => {
      scheduler.beginClose();
      await scheduler.stop();
      deadlines.clear();
    },
  };
}

type IncognitoSessionLifetimeParams = {
  context: GatewayRequestContext;
  logWarning: (message: string) => void;
  scheduler: GatewayScheduler;
};

/** Observe existing native owners; acquisition never creates a store. */
export function startIncognitoSessionLifetime(
  params: IncognitoSessionLifetimeParams,
): GatewayPostReadySidecarHandle {
  const owner = createIncognitoSessionDeadlineOwner({
    ...params,
    async deleteSession(deadline, assertCurrent) {
      const { deleteGatewaySession } = await import("./server-methods/sessions-delete.js");
      const result = await deleteGatewaySession({
        params: {
          key: deadline.sessionKey,
          agentId: deadline.agentId,
          expectedSessionId: deadline.sessionId,
        },
        client: null,
        context: params.context,
        assertCurrent,
      });
      if (!result.ok) {
        throw new Error(result.error.message);
      }
    },
  });
  const runInOwner = AsyncLocalStorage.snapshot();
  const env = { ...process.env, OPENCLAW_STATE_DIR: resolveStateDir() };
  const restartSignal = getGatewayRestartDrainSignal();
  let active = true;
  const observe = (change: SessionRowChange) => {
    if (!active || restartSignal.aborted || !("sessionKey" in change)) {
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
    // Projection observers run after committed facts settle. Resolve only this
    // owner's already-open connection and exact key; never admit a store here.
    const database = getOpenClawAgentDatabaseIfOpen({ agentId, path: storePath, env });
    const entry = database
      ? loadSessionEntryReadOnly({ agentId, sessionKey, storePath, env })
      : undefined;
    if (!database || !entry) {
      owner.forget(sessionKey);
      return;
    }
    const expiresAt = resolveIncognitoSessionExpiresAt(entry);
    if (!database.db.isOpen || expiresAt === undefined) {
      return;
    }
    owner.observe({
      sessionKey,
      agentId,
      sessionId: entry.sessionId,
      source: {
        identity: readOpenClawAgentDatabaseIdentity(database).identity,
        assertCurrent() {
          if (
            !database.db.isOpen ||
            getOpenClawAgentDatabaseIfOpen({ agentId, path: storePath, env }) !== database
          ) {
            throw new Error("Incognito expiry lost its original database");
          }
        },
      },
      expiresAt,
    });
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
      active = false;
      unsubscribe();
      await owner.stop();
    },
  };
}

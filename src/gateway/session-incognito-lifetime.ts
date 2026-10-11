import { AsyncLocalStorage } from "node:async_hooks";
import { resolveStateDir } from "../config/paths.js";
import {
  listSessionEntriesReadOnly,
  loadSessionEntryReadOnly,
} from "../config/sessions/session-accessor.js";
import { memorySessionActorOwners } from "../config/sessions/session-actor-memory-owner.js";
import type { createMemorySessionActorOwner } from "../config/sessions/session-actor-memory.js";
import {
  runWithSessionActorStorage,
  type SessionActorStorageBinding,
} from "../config/sessions/session-actor-storage-binding.js";
import type { SessionActorStorageAuthority } from "../config/sessions/session-actor-storage-contract.js";
import type { InternalSessionEntry as SessionEntry } from "../config/sessions/types.js";
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
  source: { identity: string | symbol; assertCurrent(): void; assertSettlingCurrent?(): void };
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
  const current = (deadline: Deadline, accepted = false) => {
    const registered = deadlines.get(deadline.sessionKey);
    const retaining = accepted && deadline.source.assertSettlingCurrent !== undefined;
    if (
      (!retaining && (scheduler.signal.aborted || restartSignal.aborted)) ||
      (registered !== deadline && (!retaining || registered !== undefined))
    ) {
      return false;
    }
    try {
      // An acknowledged deletion may remove its own row and deadline before cleanup settles.
      if (accepted && deadline.source.assertSettlingCurrent) {
        deadline.source.assertSettlingCurrent();
      } else {
        deadline.source.assertCurrent();
      }
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
            if (!accepted || !current(deadline, true)) {
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

/** Production acquisition remains native until every incognito caller moves together. */
export function startIncognitoSessionLifetime(params: {
  context: GatewayRequestContext;
  logWarning: (message: string) => void;
  scheduler: GatewayScheduler;
}): GatewayPostReadySidecarHandle {
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

type MemoryOwner = ReturnType<typeof createMemorySessionActorOwner>;
type MemoryDeadline = Omit<IncognitoSessionDeadline, "source">;

/** Inactive until acquisition selects the memory backend for every incognito consumer. */
export function startIncognitoActorSessionLifetime(params: {
  owner: MemoryOwner;
  scheduler: GatewayScheduler;
  logWarning: (message: string) => void;
  deleteSession: (deadline: MemoryDeadline, binding: SessionActorStorageBinding) => Promise<void>;
}): GatewayPostReadySidecarHandle {
  const { owner } = params;
  const scheduler = params.scheduler.scope();
  const authority: SessionActorStorageAuthority = { assertCurrent() {}, authorize() {} };
  const deadlines = new Map<string, MemoryDeadline & { job?: GatewayScheduledJob }>();
  let active = true;
  const forget = (sessionKey: string) => {
    deadlines.get(sessionKey)?.job?.cancel();
    deadlines.delete(sessionKey);
  };
  const schedule = (deadline: MemoryDeadline, delayMs?: number) => {
    const retained: MemoryDeadline & { job?: GatewayScheduledJob } = { ...deadline };
    deadlines.set(deadline.sessionKey, retained);
    retained.job = scheduler.schedule({
      id: `incognito-expiry:${deadline.sessionKey}`,
      ...(delayMs === undefined ? { atMs: deadline.expiresAt } : { delayMs }),
      run: async () => {
        let actor: SessionActorStorageBinding["actor"] | undefined;
        try {
          actor = await owner.acquireExisting(deadline.sessionKey, {
            assertCurrent() {},
            assertReadable() {},
          });
          if (!actor) {
            if (deadlines.get(deadline.sessionKey) === retained) {
              forget(deadline.sessionKey);
            }
            return;
          }
          const binding = { actor, authority, agentId: owner.agentId, path: owner.path };
          // Deletion checks expectedSessionId at its effect; metadata edits do not renew expiry.
          await runWithSessionActorStorage(binding, () => params.deleteSession(deadline, binding));
          if (deadlines.get(deadline.sessionKey) === retained) {
            forget(deadline.sessionKey);
          }
        } catch {
          let entry: SessionEntry | undefined;
          try {
            entry = owner.readSession(deadline.sessionKey, authority)?.entry;
          } catch {
            // Closing the memory owner already discarded these sessions.
          }
          if (deadlines.get(deadline.sessionKey) !== retained) {
            return;
          }
          if (active && entry?.sessionId === deadline.sessionId) {
            params.logWarning("Incognito session expiry could not finish cleanup; will retry.");
            schedule(deadline, CLEANUP_RETRY_MS);
          } else {
            forget(deadline.sessionKey);
          }
        } finally {
          await actor?.release();
        }
      },
    });
  };
  const observeSession = (sessionKey: string, entry: SessionEntry | undefined) => {
    const expiresAt = entry && resolveIncognitoSessionExpiresAt(entry);
    if (!entry || expiresAt === undefined) {
      forget(sessionKey);
      return;
    }
    if (deadlines.get(sessionKey)?.sessionId === entry.sessionId) {
      return;
    }
    forget(sessionKey);
    schedule({ sessionKey, sessionId: entry.sessionId, agentId: owner.agentId, expiresAt });
  };
  const observe = (change?: SessionRowChange) => {
    if (!active) {
      return;
    }
    if (change && "sessionKey" in change) {
      if (change.agentId === owner.agentId && change.storePath === owner.path) {
        observeSession(change.sessionKey, owner.readSession(change.sessionKey, authority)?.entry);
      }
      return;
    }
    const current = owner.listSessions(authority);
    const keys = new Set(current.map((state) => state.target.sessionKey));
    for (const key of deadlines.keys()) {
      if (!keys.has(key)) {
        forget(key);
      }
    }
    for (const state of current) {
      observeSession(state.target.sessionKey, state.entry);
    }
  };
  const runInOwner = AsyncLocalStorage.snapshot();
  const unsubscribe = sessionChanges.subscribeProjection((change) =>
    runInOwner(() => observe(change)),
  );
  observe();
  return {
    async stop() {
      active = false;
      unsubscribe();
      scheduler.beginClose();
      await scheduler.stop();
      deadlines.clear();
    },
  };
}

/** Existing memory owners only; native production keeps startIncognitoSessionLifetime. */
export function startIncognitoActorsSessionLifetime(params: {
  context: GatewayRequestContext;
  scheduler: GatewayScheduler;
  logWarning: (message: string) => void;
  env?: NodeJS.ProcessEnv;
}): GatewayPostReadySidecarHandle {
  const env = {
    ...(params.env ?? process.env),
    OPENCLAW_STATE_DIR: resolveStateDir(params.env ?? process.env),
  };
  const retained = new Map<MemoryOwner, GatewayPostReadySidecarHandle>();
  const stopping = new Set<Promise<void>>();
  const retire = (owner: MemoryOwner, sidecar: GatewayPostReadySidecarHandle) => {
    retained.delete(owner);
    const stopped = Promise.resolve(sidecar.stop()).catch(() => {
      params.logWarning("Incognito expiry could not finish stopping its memory owner.");
    });
    stopping.add(stopped);
    void stopped.finally(() => stopping.delete(stopped));
  };
  const observe = () => {
    const owners = memorySessionActorOwners
      .list()
      .filter(
        (owner) =>
          owner.path === resolveIncognitoOpenClawAgentSqlitePath({ agentId: owner.agentId, env }),
      );
    for (const [owner, sidecar] of retained) {
      if (!owners.includes(owner)) {
        retire(owner, sidecar);
      }
    }
    for (const owner of owners) {
      if (retained.has(owner)) {
        continue;
      }
      retained.set(
        owner,
        startIncognitoActorSessionLifetime({
          ...params,
          owner,
          async deleteSession(deadline) {
            const { deleteGatewaySession } = await import("./server-methods/sessions-delete.js");
            const result = await deleteGatewaySession({
              params: {
                key: deadline.sessionKey,
                agentId: deadline.agentId,
                expectedSessionId: deadline.sessionId,
              },
              client: null,
              context: params.context,
            });
            if (!result.ok) {
              throw new Error(result.error.message);
            }
          },
        }),
      );
    }
  };
  const runInOwner = AsyncLocalStorage.snapshot();
  const unsubscribe = sessionChanges.subscribeProjection(() => runInOwner(observe));
  observe();
  return {
    async stop() {
      unsubscribe();
      for (const [owner, sidecar] of retained) {
        retire(owner, sidecar);
      }
      await Promise.all(stopping);
    },
  };
}

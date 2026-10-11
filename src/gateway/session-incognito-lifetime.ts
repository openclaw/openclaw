import { AsyncLocalStorage } from "node:async_hooks";
import { resolveStateDir } from "../config/paths.js";
import { memorySessionActorOwners } from "../config/sessions/session-actor-memory-owner.js";
import type { createMemorySessionActorOwner } from "../config/sessions/session-actor-memory.js";
import {
  runWithSessionActorStorage,
  type SessionActorStorageBinding,
} from "../config/sessions/session-actor-storage-binding.js";
import type { SessionActorStorageAuthority } from "../config/sessions/session-actor-storage-contract.js";
import type { InternalSessionEntry as SessionEntry } from "../config/sessions/types.js";
import type { GatewayScheduler, GatewayScheduledJob } from "../infra/gateway-scheduler.js";
import { sessionChanges, type SessionRowChange } from "../sessions/session-row-changes.js";
import { resolveIncognitoSessionExpiresAt } from "../shared/incognito-session-key.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import type { GatewayPostReadySidecarHandle } from "./server-startup-sidecar-scheduler.js";

const CLEANUP_RETRY_MS = 60_000;

type MemoryOwner = ReturnType<typeof createMemorySessionActorOwner>;
type MemoryDeadline = {
  sessionKey: string;
  agentId: string;
  sessionId: string;
  expiresAt: number;
};

/** Deadlines come from committed actor state; deletion owns transport and session cleanup. */
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

/** Follow existing memory owners without creating sessions or retaining database workers. */
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

import { AsyncLocalStorage } from "node:async_hooks";
import {
  captureSessionActorStorageOwner,
  runWithSessionActorStorage,
  type CapturedSessionActorStorageOwner,
} from "../config/sessions/session-actor-storage-binding.js";
import type { GatewayScheduler } from "../infra/gateway-scheduler.js";
import { LruCache } from "../infra/lru-cache.js";
import {
  sessionChanges,
  sessionChangeScopeAffectsStoredRows,
} from "../sessions/session-row-changes.js";
import type { PublicationSessionIdentity } from "./github-publication-availability.js";
import type { RepositoryPublicationProvider } from "./repository-publication-contract.js";
import type { SelectionRow } from "./session-row-projection-record.js";
import type { RepositoryWorkerPublicationFact } from "./worker-environments/worker-github-binding.js";

type WorkspaceRow = Pick<SelectionRow, "agentId" | "key" | "entry">;
type DiscoveryProjection = {
  onSelectionChange(
    listener: (change: { kind: "reset" } | { kind: "row"; row?: WorkspaceRow }) => void,
  ): void;
};
const unavailable: RepositoryWorkerPublicationFact = { available: false };
const MAX_AGE_MS = 60_000;

/** A Gateway-owned demand cache; it never warms the session corpus or creates a memory owner. */
export function createRepositoryPublicationDiscovery(params: {
  scheduler: GatewayScheduler;
  getProvider(): RepositoryPublicationProvider;
  projection?: DiscoveryProjection;
}) {
  const inOwner = AsyncLocalStorage.snapshot();
  const scheduler = params.scheduler.scope();
  const sessions = new LruCache<{
    session: PublicationSessionIdentity;
    binding?: string;
    incognito?: Pick<CapturedSessionActorStorageOwner, "owner" | "agentId" | "path">;
    fact: RepositoryWorkerPublicationFact;
    refreshAfterMs: number;
  }>(256);
  const keyOf = (session: PublicationSessionIdentity) =>
    `${session.agentId}\0${session.sessionKey}`;
  const refresh = (key: string, retire = false) => {
    const previous = sessions.peek(key);
    if (!previous || scheduler.signal.aborted) {
      return undefined;
    }
    const current = {
      ...previous,
      fact: retire ? { available: previous.fact.available } : previous.fact,
      refreshAfterMs: scheduler.now() + MAX_AGE_MS,
    };
    sessions.set(key, current);
    inOwner(() =>
      scheduler.schedule({
        id: `repository-discovery:${key}`,
        delayMs: 0,
        run: async () => {
          const assertCurrent = () => {
            scheduler.signal.throwIfAborted();
            if (sessions.peek(key) !== current) {
              throw new Error("Repository discovery owner changed.");
            }
          };
          const prepare = async () => {
            const { prepareRepositoryWorkerPublicationFact } =
              await import("./worker-environments/worker-github-binding.js");
            assertCurrent();
            return await prepareRepositoryWorkerPublicationFact({
              ...current.session,
              provider: params.getProvider(),
              assertCurrent,
            });
          };
          let fact: RepositoryWorkerPublicationFact | undefined;
          try {
            if (current.incognito) {
              // The Gateway borrows only the existing selected namespace, independently from a turn.
              const actor = await current.incognito.owner?.acquireExisting(
                current.session.sessionKey,
                {
                  assertCurrent,
                  assertReadable: assertCurrent,
                },
              );
              if (actor) {
                try {
                  fact = await runWithSessionActorStorage(
                    {
                      actor,
                      agentId: current.incognito.agentId,
                      path: current.incognito.path,
                      authority: { assertCurrent, authorize: assertCurrent },
                    },
                    prepare,
                  );
                } finally {
                  await actor.release();
                }
              }
            } else {
              fact = await prepare();
            }
          } catch {
            fact = undefined;
          }
          if (!scheduler.signal.aborted && sessions.peek(key) === current) {
            current.fact = fact ?? unavailable;
          }
        },
      }),
    );
    return current;
  };
  const invalidate = () => {
    const keys = Array.from(sessions.keys());
    for (const key of keys) {
      refresh(key, true);
    }
  };
  const observe = (row: WorkspaceRow) => {
    if (scheduler.signal.aborted) {
      return;
    }
    const session = { agentId: row.agentId, sessionKey: row.key, sessionId: row.entry.sessionId };
    const key = keyOf(session);
    const previous = sessions.peek(key);
    if (!previous) {
      return;
    }
    if (!row.entry.repositoryWorkspaceId && !row.entry.worktree?.id) {
      // Resident absence retires pending credentials; only renewed demand may rebind.
      sessions.delete(key);
      return;
    }
    const binding = JSON.stringify([
      row.entry.lifecycleRevision,
      row.entry.worktree,
      row.entry.repositoryWorkspaceId,
    ]);
    if (previous.session.sessionId !== session.sessionId || previous.binding !== binding) {
      sessions.set(key, { session, binding, fact: unavailable, refreshAfterMs: 0 });
      refresh(key);
    }
  };
  const bindProjection = (projection: DiscoveryProjection | undefined) => {
    if (!projection) {
      return;
    }
    projection.onSelectionChange((change) => {
      if (scheduler.signal.aborted) {
        return;
      }
      if (change.kind === "row" && change.row) {
        observe(change.row);
      } else if (change.kind === "reset") {
        sessions.clear();
      }
    });
  };
  if (params.projection) {
    bindProjection(params.projection);
  }
  const stopChanges = sessionChanges.subscribeFacts((change) => {
    if ("all" in change) {
      if (
        change.scope === "config" ||
        change.scope === "profiles" ||
        sessionChangeScopeAffectsStoredRows(change)
      ) {
        invalidate();
      }
      return;
    }
    if (!sessionChangeScopeAffectsStoredRows(change)) {
      return;
    }
    const keys = Array.from(sessions.keys());
    for (const key of keys) {
      const current = sessions.peek(key);
      if (
        current?.session.sessionKey === change.sessionKey &&
        (!change.agentId || current.session.agentId === change.agentId)
      ) {
        if (change.facts?.kind === "removed") {
          sessions.delete(key);
        } else {
          refresh(key, true);
        }
      }
    }
  });
  const clear = () => {
    sessions.clear();
  };
  scheduler.signal.addEventListener(
    "abort",
    () => {
      stopChanges();
      clear();
    },
    { once: true },
  );
  return {
    bindProjection,
    clear,
    invalidate,
    read(session: PublicationSessionIdentity): RepositoryWorkerPublicationFact {
      if (scheduler.signal.aborted) {
        return unavailable;
      }
      try {
        params.getProvider().assertCurrent();
      } catch {
        return unavailable;
      }
      const key = keyOf(session);
      let current = sessions.get(key);
      if (!current || current.session.sessionId !== session.sessionId) {
        const assertOwner = () => {
          scheduler.signal.throwIfAborted();
          params.getProvider().assertCurrent();
        };
        const captured = captureSessionActorStorageOwner(session, {
          assertCurrent: assertOwner,
          authorize: assertOwner,
        });
        current = {
          session: { ...session },
          ...(captured
            ? {
                incognito: {
                  owner: captured.owner,
                  agentId: captured.agentId,
                  path: captured.path,
                },
              }
            : {}),
          fact: unavailable,
          refreshAfterMs: 0,
        };
        sessions.set(key, current);
        refresh(key);
      } else if (current.refreshAfterMs <= scheduler.now()) {
        current = refresh(key, true) ?? current;
      }
      return current.fact;
    },
  };
}

import { AsyncLocalStorage } from "node:async_hooks";
import { githubIdentityChanges } from "../agents/github-read-identity.js";
import { onManagedGitHubProfileChanged } from "../agents/github-tool-identity.js";
import type { PreparedGitHubPublicationIdentity } from "../agents/github-tool-identity.types.js";
import {
  captureSessionActorStorageOwner,
  runWithSessionActorStorage,
  type CapturedSessionActorStorageOwner,
} from "../config/sessions/session-actor-storage-binding.js";
import type { GatewayScheduler } from "../infra/gateway-scheduler.js";
import { LruCache } from "../infra/lru-cache.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import type { WorkerGitHubLaunchBinding } from "../worker/launch-descriptor.js";
import type { PublicationSessionIdentity } from "./github-publication-availability.js";
import type { SelectionRow } from "./session-row-projection-record.js";
import { prepareGitHubPublicationFact } from "./worker-environments/worker-github-binding.js";

type WorkspaceRow = Pick<SelectionRow, "agentId" | "key" | "entry">;
type PublicationFact = {
  available: boolean;
  github?: WorkerGitHubLaunchBinding;
  identity?: PreparedGitHubPublicationIdentity;
  workspaceKey?: string;
};
const unavailable: PublicationFact = { available: false };
const PUBLICATION_FACT_MAX_AGE_MS = 60_000;
let readPublished: ((session: PublicationSessionIdentity) => PublicationFact) | undefined;

/** Discovery can lag a refresh; publication and process launch still validate at the effect. */
export function readGitHubPublicationFact(session: PublicationSessionIdentity): PublicationFact {
  return readPublished?.(session) ?? unavailable;
}

export function startGitHubPublicationDiscovery(params: {
  scheduler: GatewayScheduler;
  projection?: {
    onSelectionChange(
      listener: (change: { kind: "reset" } | { kind: "row"; row?: WorkspaceRow }) => void,
    ): void;
  };
}) {
  const inOwner = AsyncLocalStorage.snapshot();
  const scheduler = params.scheduler.scope();
  const sessions = new LruCache<{
    session: PublicationSessionIdentity;
    binding?: string;
    incognito?: Pick<CapturedSessionActorStorageOwner, "owner" | "agentId" | "path">;
    fact: PublicationFact;
    refreshAfterMs: number;
  }>(256);
  const keyOf = (session: PublicationSessionIdentity) =>
    `${session.agentId}\0${session.sessionKey}`;
  const refresh = (key: string, retireCredentials = false) => {
    const previous = sessions.peek(key);
    if (!previous || scheduler.signal.aborted) {
      return undefined;
    }
    const current = {
      ...previous,
      fact: retireCredentials ? { available: previous.fact.available } : previous.fact,
      refreshAfterMs: scheduler.now() + PUBLICATION_FACT_MAX_AGE_MS,
    };
    sessions.set(key, current);
    inOwner(() =>
      scheduler.schedule({
        id: `github-publication:${key}`,
        delayMs: 0,
        run: async () => {
          const prepare = () =>
            prepareGitHubPublicationFact({
              ...current.session,
              assertCurrent: () => !scheduler.signal.aborted && sessions.peek(key) === current,
            });
          let fact: PublicationFact | undefined;
          if (current.incognito) {
            // Discovery belongs to the Gateway, independently of the borrowing turn.
            const assertCurrent = () => scheduler.signal.throwIfAborted();
            try {
              const actor = await current.incognito.owner?.acquireExisting(
                current.session.sessionKey,
                { assertCurrent, assertReadable: assertCurrent },
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
            } catch {
              // Closed memory owners retire discovery without creating a replacement.
              fact = undefined;
            }
          } else {
            fact = await prepare();
          }
          if (!scheduler.signal.aborted && sessions.peek(key) === current) {
            current.fact = fact ?? unavailable;
          }
        },
      }),
    );
    return current;
  };
  const read = (session: PublicationSessionIdentity) => {
    const key = keyOf(session);
    let current = sessions.get(key);
    if (!current || current.session.sessionId !== session.sessionId) {
      current = {
        session: { ...session },
        incognito: captureSessionActorStorageOwner(session, {
          assertCurrent: () => scheduler.signal.throwIfAborted(),
          authorize() {},
        }),
        fact: unavailable,
        refreshAfterMs: 0,
      };
      sessions.set(key, current);
      refresh(key);
    } else if (current.refreshAfterMs <= scheduler.now()) {
      // Idle sessions need no polling; an expired credential cannot authorize a new launch.
      current = refresh(key, true) ?? current;
    }
    return current.fact;
  };
  readPublished = read;
  const refreshAll = (retireCredentials = false) => {
    // Refresh replaces LRU entries; the live iterator would revisit them.
    const keys = [...sessions.keys()];
    for (const key of keys) {
      refresh(key, retireCredentials);
    }
  };
  const stopProfile = onManagedGitHubProfileChanged(() => refreshAll(true));
  githubIdentityChanges.onChange = () => refreshAll(true);
  const stopConfig = sessionChanges.subscribe((change) => {
    if ("all" in change && change.scope === "config") {
      refreshAll(true);
    }
  });
  const observe = (row: WorkspaceRow) => {
    if (scheduler.signal.aborted) {
      return;
    }
    const session = { agentId: row.agentId, sessionKey: row.key, sessionId: row.entry.sessionId };
    const key = keyOf(session);
    // Only demand creates discovery work; roster hydration must not warm the whole corpus.
    const previous = sessions.peek(key);
    if (!previous) {
      return;
    }
    if (!row.entry.repositoryWorkspaceId && !row.entry.worktree?.id) {
      // Resident absence retires pending facts; explicit demand can still prepare an unknown target.
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
  params.projection?.onSelectionChange((change) => {
    if (change.kind === "row" && change.row) {
      observe(change.row);
    }
  });
  return {
    stop: async () => {
      scheduler.beginClose();
      githubIdentityChanges.onChange = undefined;
      stopProfile();
      stopConfig();
      if (readPublished === read) {
        readPublished = undefined;
      }
      sessions.clear();
      await scheduler.stop();
    },
  };
}

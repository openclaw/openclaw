import { AsyncLocalStorage } from "node:async_hooks";
import { subscribeGitHubIdentityChanges } from "../agents/github-read-identity.js";
import {
  captureIncognitoSessionBinding,
  withAcquiredIncognitoSessionBinding,
  type IncognitoSessionBinding,
} from "../config/sessions/session-incognito-binding.js";
import type { GatewayScheduler } from "../infra/gateway-scheduler.js";
import { LruCache } from "../infra/lru-cache.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import type { WorkerGitHubLaunchBinding } from "../worker/launch-descriptor.js";
import type { PublicationSessionIdentity } from "./github-publication-availability.js";
import type { SelectionRow } from "./session-row-projection-record.js";
import { prepareGitHubPublicationFact } from "./worker-environments/worker-github-binding.js";

type WorkspaceRow = Pick<SelectionRow, "agentId" | "key" | "entry">;
type PublicationFact = { available: boolean; github?: WorkerGitHubLaunchBinding };
const unavailable: PublicationFact = { available: false };
let readPublished: ((session: PublicationSessionIdentity) => PublicationFact) | undefined;

/** Discovery can lag a refresh; publication and process launch still validate at the effect. */
export function readGitHubPublicationFact(session: PublicationSessionIdentity): PublicationFact {
  return readPublished?.(session) ?? unavailable;
}

export function startGitHubPublicationDiscovery(params: {
  scheduler: GatewayScheduler;
  projection?: {
    ensureMaterialized(): Promise<void>;
    selectEntries(): WorkspaceRow[];
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
    incognito?: Pick<IncognitoSessionBinding["actor"], "path" | "identity">;
    fact: PublicationFact;
  }>(256);
  const keyOf = (session: PublicationSessionIdentity) =>
    `${session.agentId}\0${session.sessionKey}`;
  const refresh = (key: string, retireCredentials = false) => {
    const previous = sessions.peek(key);
    if (!previous || scheduler.signal.aborted) {
      return;
    }
    const current = {
      ...previous,
      fact: retireCredentials ? { available: previous.fact.available } : previous.fact,
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
          const fact = await (current.incognito
            ? withAcquiredIncognitoSessionBinding(
                { ...current.session, storePath: current.incognito.path },
                { assertCurrent: () => scheduler.signal.throwIfAborted() },
                async ({ actor }) =>
                  actor.identity.incarnation === current.incognito?.identity.incarnation
                    ? prepare()
                    : undefined,
                { signal: scheduler.signal },
              )
            : prepare());
          if (!scheduler.signal.aborted && sessions.peek(key) === current) {
            current.fact = fact ?? unavailable;
          }
        },
      }),
    );
  };
  const read = (session: PublicationSessionIdentity) => {
    const key = keyOf(session);
    let current = sessions.get(key);
    if (!current || current.session.sessionId !== session.sessionId) {
      current = {
        session: { ...session },
        incognito: captureIncognitoSessionBinding(session)?.actor,
        fact: unavailable,
      };
      sessions.set(key, current);
      refresh(key);
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
  const stopIdentity = subscribeGitHubIdentityChanges(() => refreshAll(true));
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
    const binding = JSON.stringify([
      row.entry.lifecycleRevision,
      row.entry.worktree,
      row.entry.repositoryWorkspaceId,
    ]);
    const previous = sessions.peek(key);
    if (previous?.session.sessionId !== session.sessionId || previous.binding !== binding) {
      sessions.set(key, { session, binding, fact: unavailable });
      refresh(key);
    }
  };
  params.projection?.onSelectionChange((change) => {
    if (change.kind === "row" && change.row) {
      observe(change.row);
    }
  });
  scheduler.schedule({
    id: "github-publication-startup",
    delayMs: 0,
    run: async () => {
      await params.projection?.ensureMaterialized();
      for (const row of params.projection?.selectEntries() ?? []) {
        observe(row);
      }
    },
  });
  scheduler.schedule({
    id: "github-publication-discovery",
    delayMs: 60_000,
    everyMs: 60_000,
    run: () => refreshAll(),
  });
  return {
    stop: async () => {
      scheduler.beginClose();
      stopIdentity();
      stopConfig();
      if (readPublished === read) {
        readPublished = undefined;
      }
      sessions.clear();
      await scheduler.stop();
    },
  };
}

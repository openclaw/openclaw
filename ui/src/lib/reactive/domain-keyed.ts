import type { createStoredChatOutboxReader } from "../chat/outbox-store-projection.ts";
import type { ProjectCatalog } from "../projects.ts";
import type { SessionProgressCardStore } from "../session-progress-cards.ts";
import type { SessionPullRequestSnapshotStore } from "../session-pull-requests.ts";
import { projectSource } from "./projection.ts";

export function projectProjects(
  source: Pick<ProjectCatalog, "snapshot" | "loading" | "subscribe">,
) {
  return projectSource(source, {
    read: (catalog) => ({ snapshot: catalog.snapshot, loading: catalog.loading }),
    subscribe: (catalog, notify) => catalog.subscribe(notify),
    equality: "revision",
  });
}

export type ProgressCardProjectionSource = {
  store: SessionProgressCardStore;
  target: Parameters<SessionProgressCardStore["get"]>[0];
  options?: Parameters<SessionProgressCardStore["watch"]>[2];
};

export function projectProgressCard(source: ProgressCardProjectionSource) {
  return projectSource(source, {
    read: ({ store, target }) => ({
      card: store.get(target),
      lifetime: store.getLifetime(target),
      error: store.getError(target),
      refreshState: store.getRefreshState(target),
    }),
    subscribe: ({ store, target, options }, notify) => {
      const owner = {};
      const stop = store.subscribe(notify);
      store.watch(owner, [target], options);
      return () => {
        store.unwatch(owner);
        stop();
      };
    },
    equality: "revision",
  });
}

export type PullRequestsProjectionSource = {
  store: SessionPullRequestSnapshotStore;
  sessionKey: string;
  options?: Parameters<SessionPullRequestSnapshotStore["watch"]>[2];
};

export function projectPullRequests(source: PullRequestsProjectionSource) {
  return projectSource(source, {
    read: ({ store, sessionKey }) => store.get(sessionKey),
    subscribe: ({ store, sessionKey, options }, notify) => {
      const owner = {};
      const stop = store.subscribe(notify);
      store.watch(owner, [sessionKey], options);
      return () => {
        store.unwatch(owner);
        stop();
      };
    },
    equality: "revision",
  });
}

type StoredOutboxReader = ReturnType<typeof createStoredChatOutboxReader>;

export type StoredOutboxProjectionSource = {
  reader: StoredOutboxReader;
  scope: Parameters<StoredOutboxReader["read"]>[0];
};

export function projectStoredOutbox(source: StoredOutboxProjectionSource) {
  return projectSource(source, {
    read: ({ reader, scope }) => reader.read(scope),
    subscribe: ({ reader }, notify) => reader.subscribe(notify),
    equality: "revision",
  });
}

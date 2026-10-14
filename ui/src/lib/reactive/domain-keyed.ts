import type { SessionProgressCardStore } from "../session-progress-cards.ts";
import { projectSource } from "./projection.ts";

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

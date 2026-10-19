import {
  readSessionProgressCard,
  type SessionProgressCardStore,
} from "../session-progress-cards.ts";
import { projectSource } from "./projection.ts";

export type ProgressCardProjectionSource = {
  store: SessionProgressCardStore | undefined;
  target: Parameters<SessionProgressCardStore["get"]>[0] | undefined;
  options?: Parameters<SessionProgressCardStore["watch"]>[2];
};

export function projectProgressCard(source: ProgressCardProjectionSource) {
  let currentSource = source;
  const projection = projectSource(source, {
    read: ({ store, target }) => readSessionProgressCard(store, target),
    subscribe: ({ store, target, options }, notify) => {
      if (!store) {
        return () => {};
      }
      const owner = {};
      const stop = store.subscribe(notify);
      store.watch(owner, target ? [target] : [], options);
      return () => {
        store.unwatch(owner);
        stop();
      };
    },
    equality: (previous, next) =>
      previous.card === next.card &&
      previous.lifetime === next.lifetime &&
      previous.error === next.error &&
      previous.refreshState === next.refreshState,
  });
  return {
    ...projection,
    replaceSource(next: ProgressCardProjectionSource) {
      if (next === currentSource) {
        return;
      }
      // A same-store handoff must not trigger idle teardown and discard cached cards.
      const release = next.store?.subscribe(() => {});
      try {
        projection.replaceSource(next);
        currentSource = next;
      } finally {
        release?.();
      }
    },
  };
}

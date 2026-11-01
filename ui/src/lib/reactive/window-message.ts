import { listen } from "./listener.ts";

type Subscription = { callback: (event: MessageEvent) => void };
type MessagePool = {
  sources: Map<MessageEventSource, Set<Subscription>>;
  stop: () => void;
};

const pools = new WeakMap<Window, MessagePool>();

/** Route frame messages by source; payload and authority checks stay with each frame owner. */
export function observeWindowMessage(
  view: Window,
  source: WindowProxy,
  callback: (event: MessageEvent) => void,
): () => void {
  let pool = pools.get(view);
  if (!pool) {
    const sources = new Map<MessageEventSource, Set<Subscription>>();
    pool = {
      sources,
      stop: listen(view, "message", (event) => {
        const subscribers = event.source && sources.get(event.source);
        if (!subscribers) {
          return;
        }
        const delivery = [...subscribers];
        for (const subscriber of delivery) {
          if (!subscribers.has(subscriber)) {
            continue;
          }
          try {
            subscriber.callback(event);
          } catch (error) {
            reportError(error);
          }
        }
      }),
    };
    pools.set(view, pool);
  }
  let subscribers = pool.sources.get(source);
  if (!subscribers) {
    subscribers = new Set();
    pool.sources.set(source, subscribers);
  }
  const subscription = { callback };
  subscribers.add(subscription);
  return () => {
    if (!subscribers.delete(subscription)) {
      return;
    }
    if (subscribers.size === 0) {
      pool.sources.delete(source);
    }
    if (pool.sources.size === 0) {
      pool.stop();
      pools.delete(view);
    }
  };
}

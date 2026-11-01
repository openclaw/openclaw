import { listen } from "./listener.ts";

type Subscription = { callback: () => void };
type ResizePool = { subscribers: Set<Subscription>; stop: () => void };

const pools = new WeakMap<Window, ResizePool>();

/** Share native resize delivery without changing callers' synchronous layout policy. */
export function observeWindowResize(view: Window, callback: () => void): () => void {
  let pool = pools.get(view);
  if (!pool) {
    const subscribers = new Set<Subscription>();
    pool = {
      subscribers,
      stop: listen(view, "resize", () => {
        const delivery = [...subscribers];
        for (const subscriber of delivery) {
          if (!subscribers.has(subscriber)) {
            continue;
          }
          try {
            subscriber.callback();
          } catch (error) {
            reportError(error);
          }
        }
      }),
    };
    pools.set(view, pool);
  }
  const subscription = { callback };
  pool.subscribers.add(subscription);
  return () => {
    if (!pool.subscribers.delete(subscription)) {
      return;
    }
    if (pool.subscribers.size === 0) {
      pool.stop();
      pools.delete(view);
    }
  };
}

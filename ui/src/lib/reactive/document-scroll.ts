import { listen } from "./listener.ts";

type Subscription = { callback: () => void };
type ScrollPool = { subscribers: Set<Subscription>; stop: () => void };
const pools = new WeakMap<Document, ScrollPool>();

/** Capture descendant scrollers too; native view coordinates are viewport-relative. */
export function observeDocumentScroll(document: Document, callback: () => void): () => void {
  let pool = pools.get(document);
  if (!pool) {
    const subscribers = new Set<Subscription>();
    pool = {
      subscribers,
      stop: listen(
        document,
        "scroll",
        () => {
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
        },
        true,
      ),
    };
    pools.set(document, pool);
  }
  const subscription = { callback };
  pool.subscribers.add(subscription);
  return () => {
    if (!pool.subscribers.delete(subscription)) {
      return;
    }
    if (pool.subscribers.size === 0) {
      pool.stop();
      pools.delete(document);
    }
  };
}

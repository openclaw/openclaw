import { listen } from "./listener.ts";

type Subscription = {
  callback: (event: MessageEvent) => void;
  order: number;
};
type MessagePool = {
  subscriptions: Map<MessageEventSource | HTMLIFrameElement, Set<Subscription>>;
  frames: Set<HTMLIFrameElement>;
  nextOrder: number;
  stop: () => void;
};

const pools = new WeakMap<Window, MessagePool>();

/** Route frame messages by source; payload and authority checks stay with each frame owner. */
export function observeWindowMessage(
  view: Window,
  source: WindowProxy | HTMLIFrameElement,
  callback: (event: MessageEvent) => void,
): () => void {
  let pool = pools.get(view);
  if (!pool) {
    const subscriptions: MessagePool["subscriptions"] = new Map();
    const frames = new Set<HTMLIFrameElement>();
    const frameBySource = new WeakMap<MessageEventSource, HTMLIFrameElement>();
    pool = {
      subscriptions,
      frames,
      nextOrder: 0,
      stop: listen(view, "message", (event) => {
        const sender = event.source;
        if (!sender) {
          return;
        }
        // A retained element can acquire a new WindowProxy. Cache the lookup,
        // not the binding: only its current contentWindow can deliver messages.
        let frame = frameBySource.get(sender);
        if (!frame || !frames.has(frame) || frame.contentWindow !== sender) {
          frame = undefined;
          for (const candidate of frames) {
            if (candidate.contentWindow === sender) {
              frame = candidate;
              frameBySource.set(sender, frame);
              break;
            }
          }
        }
        const direct = subscriptions.get(sender);
        const current = frame && subscriptions.get(frame);
        if (!direct && !current) {
          return;
        }
        const delivery =
          direct && current
            ? [...direct, ...current].toSorted((left, right) => left.order - right.order)
            : [...(direct ?? current!)];
        for (const subscriber of delivery) {
          if (
            !direct?.has(subscriber) &&
            !(current?.has(subscriber) && frame?.contentWindow === sender)
          ) {
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
  // Reading contentWindow at registration can initialize the child's context.
  if (source instanceof HTMLIFrameElement) {
    pool.frames.add(source);
  }
  const subscription: Subscription = { callback, order: pool.nextOrder++ };
  const subscribers = pool.subscriptions.get(source) ?? new Set<Subscription>();
  pool.subscriptions.set(source, subscribers);
  subscribers.add(subscription);
  return () => {
    if (!subscribers.delete(subscription) || subscribers.size > 0) {
      return;
    }
    pool.subscriptions.delete(source);
    if (source instanceof HTMLIFrameElement) {
      pool.frames.delete(source);
    }
    if (pool.subscriptions.size === 0) {
      pool.stop();
      pools.delete(view);
    }
  };
}

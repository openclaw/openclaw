import { listen } from "./listener.ts";

type Subscription = {
  callback: (event: MessageEvent) => void;
  order: number;
  source?: MessageEventSource;
};
type MessagePool = {
  sources: Map<MessageEventSource, Set<Subscription>>;
  frames: Map<HTMLIFrameElement, Set<Subscription>>;
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
    const sources = new Map<MessageEventSource, Set<Subscription>>();
    const frames = new Map<HTMLIFrameElement, Set<Subscription>>();
    pool = {
      sources,
      frames,
      nextOrder: 0,
      stop: listen(view, "message", (event) => {
        if (!event.source) {
          return;
        }
        for (const [frame, pending] of frames) {
          if (frame.contentWindow !== event.source) {
            continue;
          }
          const merged = [...(sources.get(event.source) ?? []), ...pending].toSorted(
            (left, right) => left.order - right.order,
          );
          for (const subscription of pending) {
            subscription.source = event.source;
          }
          sources.set(event.source, new Set(merged));
          frames.delete(frame);
        }
        const subscribers = sources.get(event.source);
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
  const subscription: Subscription = { callback, order: pool.nextOrder++ };
  let frame: HTMLIFrameElement | undefined;
  if (source instanceof HTMLIFrameElement) {
    frame = source;
    // Reading contentWindow here can synchronously initialize the child's context.
    // Its first message supplies the source after the child is running.
    let pending = pool.frames.get(frame);
    if (!pending) {
      pending = new Set();
      pool.frames.set(frame, pending);
    }
    pending.add(subscription);
  } else {
    subscription.source = source;
    let subscribers = pool.sources.get(subscription.source);
    if (!subscribers) {
      subscribers = new Set();
      pool.sources.set(subscription.source, subscribers);
    }
    subscribers.add(subscription);
  }
  return () => {
    const resolvedSource = subscription.source;
    const subscribers = resolvedSource ? pool.sources.get(resolvedSource) : pool.frames.get(frame!);
    if (!subscribers?.delete(subscription)) {
      return;
    }
    if (subscribers.size === 0) {
      if (resolvedSource) {
        pool.sources.delete(resolvedSource);
      } else {
        pool.frames.delete(frame!);
      }
    }
    if (pool.sources.size === 0 && pool.frames.size === 0) {
      pool.stop();
      pools.delete(view);
    }
  };
}

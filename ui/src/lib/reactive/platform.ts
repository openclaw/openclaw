import { createSignal, onCleanup, onSettled } from "solid-js";
import { listen } from "./listener.ts";

type BooleanListener = (value: boolean) => void;
type BooleanSubscription = {
  listeners: Set<BooleanListener>;
  stop: () => void;
};
type MediaSubscription = {
  media: MediaQueryList;
  readers: number;
  listeners: Set<BooleanListener>;
  stop?: () => void;
};
const mediaQueries = new WeakMap<Document, Map<string, MediaSubscription>>();
const visibility = new WeakMap<Document, BooleanSubscription>();

/** Synchronous native reads share a query; only subscribers retain its change listener. */
export function createMediaQuerySource(query: string, fallback = false) {
  const ownerDocument = document;
  const queries = mediaQueries.get(ownerDocument) ?? new Map<string, MediaSubscription>();
  let subscription = queries.get(query);
  if (!subscription) {
    const media = ownerDocument.defaultView?.matchMedia?.(query);
    if (!media) {
      return { read: () => fallback, subscribe: (_listener: BooleanListener) => () => {} };
    }
    subscription = { media, readers: 0, listeners: new Set() };
    queries.set(query, subscription);
    mediaQueries.set(ownerDocument, queries);
  }
  const current = subscription;
  current.readers += 1;
  const ownedListeners = new Set<BooleanListener>();
  const releaseUnused = () => {
    if (current.listeners.size === 0) {
      current.stop?.();
      current.stop = undefined;
      if (current.readers === 0) {
        queries.delete(query);
        if (queries.size === 0) {
          mediaQueries.delete(ownerDocument);
        }
      }
    }
  };
  onCleanup(() => {
    for (const listener of ownedListeners) {
      current.listeners.delete(listener);
    }
    ownedListeners.clear();
    current.readers -= 1;
    releaseUnused();
  });
  return {
    read: () => current.media.matches,
    subscribe(listener: BooleanListener) {
      const entry = (value: boolean) => listener(value);
      ownedListeners.add(entry);
      current.listeners.add(entry);
      current.stop ??= listen(current.media, "change", () => {
        const value = current.media.matches;
        const delivery = [...current.listeners];
        for (const callback of delivery) {
          if (current.listeners.has(callback)) {
            try {
              callback(value);
            } catch (error) {
              reportError(error);
            }
          }
        }
      });
      return () => {
        if (ownedListeners.delete(entry)) {
          current.listeners.delete(entry);
          releaseUnused();
        }
      };
    },
  };
}

/** A browser capability that follows changes after the owner settles. */
export function createMediaQuery(query: string, fallback = false) {
  const source = createMediaQuerySource(query, fallback);
  const [matches, setMatches] = createSignal(fallback);
  onSettled(() => {
    const stop = source.subscribe(setMatches);
    setMatches(source.read());
    return stop;
  });
  return matches;
}

/** Share native visibility events; initial delivery belongs to each consumer's lifecycle. */
export function subscribeDocumentVisibility(
  ownerDocument: Document,
  notify: BooleanListener,
): () => void {
  let subscription = visibility.get(ownerDocument);
  if (!subscription) {
    const listeners = new Set<BooleanListener>();
    subscription = {
      listeners,
      stop: listen(ownerDocument, "visibilitychange", () => {
        const value = ownerDocument.visibilityState !== "hidden";
        const delivery = [...listeners];
        for (const listener of delivery) {
          if (listeners.has(listener)) {
            try {
              listener(value);
            } catch (error) {
              reportError(error);
            }
          }
        }
      }),
    };
    visibility.set(ownerDocument, subscription);
  }
  const current = subscription;
  const entry: BooleanListener = (value) => notify(value);
  current.listeners.add(entry);
  return () => {
    if (current.listeners.delete(entry) && current.listeners.size === 0) {
      current.stop();
      visibility.delete(ownerDocument);
    }
  };
}

/** Whether the document can present work; refresh on setup in case it changed before settlement. */
export function createDocumentVisibility() {
  const ownerDocument = document;
  const [visible, setVisible] = createSignal(ownerDocument.visibilityState !== "hidden");
  onSettled(() => {
    const stop = subscribeDocumentVisibility(ownerDocument, setVisible);
    setVisible(ownerDocument.visibilityState !== "hidden");
    return stop;
  });
  return visible;
}

import { listen } from "./listener.ts";

const subscriptions = new WeakMap<FontFaceSet, { listeners: Set<() => void>; stop: () => void }>();

/** Font metrics notify every measurement owner through one listener per font set. */
export function observeFontLoading(fonts: FontFaceSet | undefined, notify: () => void) {
  if (!fonts) {
    return () => {};
  }
  let subscription = subscriptions.get(fonts);
  if (!subscription) {
    const listeners = new Set<() => void>();
    subscription = {
      listeners,
      stop: listen(fonts, "loadingdone", () => {
        const delivery = [...listeners];
        for (const listener of delivery) {
          if (listeners.has(listener)) {
            try {
              listener();
            } catch (error) {
              // Match independent native listeners: report failures without losing sibling updates.
              reportError(error);
            }
          }
        }
      }),
    };
    subscriptions.set(fonts, subscription);
  }
  const current = subscription;
  const listener = () => notify();
  current.listeners.add(listener);
  return () => {
    if (current.listeners.delete(listener) && current.listeners.size === 0) {
      current.stop();
      subscriptions.delete(fonts);
    }
  };
}

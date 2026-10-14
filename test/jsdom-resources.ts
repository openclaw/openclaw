import { isRepoOwnedRegistrationStack } from "./jsdom-compat.mts";

export type JsdomResourceTracking = {
  document: Document;
  retire(): void;
};

// Source modules re-evaluate between files, unlike externalized dependencies.
// Their native registrations must retire with that generation, not accumulate
// on the shared window after their module graph and DOM fixtures are gone.
export function trackJsdomResources(): JsdomResourceTracking | undefined {
  if (typeof document === "undefined" || typeof MutationObserver === "undefined") {
    return undefined;
  }
  const ownerDocument = document;
  const listeners: [EventTarget, string, EventListenerOrEventListenerObject, boolean][] = [];
  const observers = new Set<MutationObserver>();
  // Native methods are captured once and always invoked with their original target.
  // oxlint-disable-next-line typescript/unbound-method -- called with the native EventTarget as this.
  const add = EventTarget.prototype.addEventListener;
  // oxlint-disable-next-line typescript/unbound-method -- called with the native EventTarget as this.
  const remove = EventTarget.prototype.removeEventListener;
  EventTarget.prototype.addEventListener = function (type, callback, options) {
    // Only these targets survive body replacement. Avoid a stack capture for
    // the ordinary short-lived element listeners in every rendered view.
    if (
      callback &&
      (this === window ||
        this === ownerDocument ||
        this === ownerDocument.body ||
        this === ownerDocument.head ||
        this === ownerDocument.documentElement) &&
      isRepoOwnedRegistrationStack(new Error().stack)
    ) {
      listeners.push([
        this,
        type,
        callback,
        typeof options === "boolean" ? options : Boolean(options?.capture),
      ]);
    }
    return add.call(this, type, callback, options);
  };
  // Vitest captures window.addEventListener before tests to count error handlers;
  // that own method bypasses EventTarget.prototype and needs the same ownership.
  const addWindow = window.addEventListener.bind(window);
  const removeWindow = window.removeEventListener.bind(window);
  window.addEventListener = function (
    type: string,
    callback: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ) {
    if (callback && isRepoOwnedRegistrationStack(new Error().stack)) {
      listeners.push([
        window,
        type,
        callback,
        typeof options === "boolean" ? options : Boolean(options?.capture),
      ]);
    }
    return addWindow(type, callback, options);
  };
  window.removeEventListener = function (
    type: string,
    callback: EventListenerOrEventListenerObject,
    options?: boolean | EventListenerOptions,
  ) {
    const capture = typeof options === "boolean" ? options : Boolean(options?.capture);
    const index = listeners.findIndex(
      ([target, event, listener, capturing]) =>
        target === window && event === type && listener === callback && capturing === capture,
    );
    if (index >= 0) {
      // Vitest decrements its Window error-handler count even for a no-op native
      // removal. Retire only the registrations not already removed by their owner.
      listeners.splice(index, 1);
    }
    return removeWindow(type, callback, options);
  };
  const NativeMutationObserver = MutationObserver;
  class TrackedMutationObserver extends NativeMutationObserver {
    constructor(callback: MutationCallback) {
      super(callback);
      if (isRepoOwnedRegistrationStack(new Error().stack)) {
        observers.add(this);
      }
    }
  }
  // Vitest's jsdom globals and window are distinct objects. Source may use either.
  globalThis.MutationObserver = window.MutationObserver = TrackedMutationObserver;
  return {
    document: ownerDocument,
    retire() {
      for (const observer of observers) {
        observer.disconnect();
      }
      observers.clear();
      for (const [target, type, callback, capture] of listeners) {
        if (target === window) {
          removeWindow(type, callback, capture);
        } else {
          remove.call(target, type, callback, capture);
        }
      }
      listeners.length = 0;
    },
  };
}

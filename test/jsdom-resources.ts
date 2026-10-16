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
  const ownerWindow = window;
  const eventTargetPrototype = ownerWindow.EventTarget.prototype;
  const listeners: [EventTarget, string, EventListenerOrEventListenerObject, boolean][] = [];
  const observers = new Set<MutationObserver>();
  const forgetListener = (
    target: EventTarget,
    type: string,
    callback: EventListenerOrEventListenerObject | null,
    options?: boolean | EventListenerOptions,
  ) => {
    const capture = typeof options === "boolean" ? options : Boolean(options?.capture);
    for (let index = listeners.length - 1; index >= 0; index--) {
      const [eventTarget, event, listener, capturing] = listeners[index]!;
      if (
        eventTarget === target &&
        event === type &&
        listener === callback &&
        capturing === capture
      ) {
        listeners.splice(index, 1);
      }
    }
  };
  // Native methods are captured once and always invoked with their original target.
  // oxlint-disable-next-line typescript/unbound-method -- called with the native EventTarget as this.
  const add = eventTargetPrototype.addEventListener;
  // oxlint-disable-next-line typescript/unbound-method -- called with the native EventTarget as this.
  const remove = eventTargetPrototype.removeEventListener;
  eventTargetPrototype.addEventListener = function (type, callback, options) {
    // Only these targets survive body replacement. Avoid a stack capture for
    // the ordinary short-lived element listeners in every rendered view.
    if (
      callback &&
      (this === ownerWindow ||
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
  eventTargetPrototype.removeEventListener = function (type, callback, options) {
    forgetListener(this, type, callback, options);
    return remove.call(this, type, callback, options);
  };
  // Vitest captures window.addEventListener before tests to count error handlers;
  // that own method bypasses EventTarget.prototype and needs the same ownership.
  const addWindow = ownerWindow.addEventListener.bind(ownerWindow);
  const removeWindow = ownerWindow.removeEventListener.bind(ownerWindow);
  ownerWindow.addEventListener = function (
    type: string,
    callback: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ) {
    if (callback && isRepoOwnedRegistrationStack(new Error().stack)) {
      listeners.push([
        ownerWindow,
        type,
        callback,
        typeof options === "boolean" ? options : Boolean(options?.capture),
      ]);
    }
    return addWindow(type, callback, options);
  };
  ownerWindow.removeEventListener = function (
    type: string,
    callback: EventListenerOrEventListenerObject,
    options?: boolean | EventListenerOptions,
  ) {
    // Vitest counts Window error-handler removals, including native no-ops.
    forgetListener(ownerWindow, type, callback, options);
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
  globalThis.MutationObserver = ownerWindow.MutationObserver = TrackedMutationObserver;
  return {
    document: ownerDocument,
    retire() {
      for (const observer of observers) {
        observer.disconnect();
      }
      observers.clear();
      for (const [target, type, callback, capture] of listeners.splice(0)) {
        if (target === ownerWindow) {
          removeWindow(type, callback, capture);
        } else {
          remove.call(target, type, callback, capture);
        }
      }
    },
  };
}

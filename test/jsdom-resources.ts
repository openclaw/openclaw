import { isRepoOwnedRegistrationStack } from "./jsdom-compat.mts";

export type JsdomResourceTracking = {
  document: Document;
  pendingListeners(): readonly JsdomListener[];
  retire(): void;
};

type JsdomListener = {
  target: EventTarget;
  type: string;
  callback: EventListenerOrEventListenerObject;
  registered: EventListenerOrEventListenerObject;
  capture: boolean;
  signal?: AbortSignal;
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
  const listeners: JsdomListener[] = [];
  const observers = new Set<MutationObserver>();
  const wrapped = new WeakSet<EventListenerOrEventListenerObject>();
  const forgetListener = (
    target: EventTarget,
    type: string,
    callback: EventListenerOrEventListenerObject | null,
    options?: boolean | EventListenerOptions,
  ) => {
    const capture = typeof options === "boolean" ? options : Boolean(options?.capture);
    let registered: EventListenerOrEventListenerObject | undefined;
    for (let index = listeners.length - 1; index >= 0; index--) {
      const {
        target: eventTarget,
        type: event,
        callback: listener,
        capture: capturing,
      } = listeners[index]!;
      if (
        eventTarget === target &&
        event === type &&
        listener === callback &&
        capturing === capture
      ) {
        registered ??= listeners[index]!.registered;
        listeners.splice(index, 1);
      }
    }
    return registered ?? callback;
  };
  const rememberListener = (
    target: EventTarget,
    type: string,
    callback: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ) => {
    const capture = typeof options === "boolean" ? options : Boolean(options?.capture);
    if (wrapped.has(callback)) {
      return callback;
    }
    const signal = typeof options === "object" ? options?.signal : undefined;
    const existing = listeners.find(
      (entry) =>
        entry.target === target &&
        entry.type === type &&
        entry.callback === callback &&
        entry.capture === capture &&
        !entry.signal?.aborted,
    );
    if (existing) {
      return existing.registered;
    }
    if (signal?.aborted) {
      return callback;
    }
    const registered =
      typeof options === "object" && options?.once
        ? function (this: EventTarget, event: Event) {
            forgetListener(target, type, callback, capture);
            if (typeof callback === "function") {
              callback.call(this, event);
            } else {
              callback.handleEvent(event);
            }
          }
        : callback;
    if (registered !== callback) {
      wrapped.add(registered);
    }
    listeners.push({ target, type, callback, registered, capture, signal });
    return registered;
  };
  // Native methods are captured once and always invoked with their original target.
  // oxlint-disable-next-line typescript/unbound-method -- called with the native EventTarget as this.
  const add = eventTargetPrototype.addEventListener;
  // oxlint-disable-next-line typescript/unbound-method -- called with the native EventTarget as this.
  const remove = eventTargetPrototype.removeEventListener;
  eventTargetPrototype.addEventListener = function (type, callback, options) {
    let registered = callback;
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
      registered = rememberListener(this, type, callback, options);
    }
    return add.call(this, type, registered, options);
  };
  eventTargetPrototype.removeEventListener = function (type, callback, options) {
    return remove.call(this, type, forgetListener(this, type, callback, options), options);
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
    let registered = callback;
    if (callback && isRepoOwnedRegistrationStack(new Error().stack)) {
      registered = rememberListener(ownerWindow, type, callback, options);
    }
    return addWindow(type, registered, options);
  };
  ownerWindow.removeEventListener = function (
    type: string,
    callback: EventListenerOrEventListenerObject,
    options?: boolean | EventListenerOptions,
  ) {
    // Vitest counts Window error-handler removals, including native no-ops.
    return removeWindow(type, forgetListener(ownerWindow, type, callback, options)!, options);
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
    pendingListeners() {
      return listeners.filter((entry) => !entry.signal?.aborted);
    },
    retire() {
      for (const observer of observers) {
        observer.disconnect();
      }
      observers.clear();
      for (const { target, type, registered, capture } of listeners.splice(0)) {
        if (target === ownerWindow) {
          removeWindow(type, registered, capture);
        } else {
          remove.call(target, type, registered, capture);
        }
      }
    },
  };
}

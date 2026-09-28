import { createDeferredCore } from "../shared/deferred.js";
import type { AsyncDebugProxyCaptureStore } from "./store.types.js";

// Capture sessions must settle while their exact store is still writable.
// This registry avoids a runtime/store import cycle and never acquires a store.
const finalizers = new WeakMap<object, Set<() => void>>();
const closed = new WeakSet<object>();

export function registerCaptureStoreFinalizer(store: object, finalize: () => void): () => void {
  if (closed.has(store)) {
    throw new Error("Capture store is already finalized.");
  }
  let callbacks = finalizers.get(store);
  if (!callbacks) {
    callbacks = new Set();
    finalizers.set(store, callbacks);
  }
  callbacks.add(finalize);
  return () => callbacks.delete(finalize);
}

export function finalizeCaptureStore(store: object): void {
  if (closed.has(store)) {
    return;
  }
  closed.add(store);
  const callbacks = finalizers.get(store);
  finalizers.delete(store);
  const errors: unknown[] = [];
  for (const finalize of callbacks ?? []) {
    try {
      finalize();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length) {
    throw new AggregateError(errors, "Capture store finalization failed.");
  }
}

type AsyncFinalizer = (store: AsyncDebugProxyCaptureStore) => Promise<void>;
const asyncFinalizers = new WeakMap<object, Set<AsyncFinalizer>>();
const asyncFinalizations = new WeakMap<object, Promise<void>>();

export function registerAsyncCaptureStoreFinalizer(
  store: object,
  finalize: AsyncFinalizer,
): () => void {
  if (closed.has(store)) {
    throw new Error("Capture store is already finalized.");
  }
  let callbacks = asyncFinalizers.get(store);
  if (!callbacks) {
    callbacks = new Set();
    asyncFinalizers.set(store, callbacks);
  }
  callbacks.add(finalize);
  return () => callbacks.delete(finalize);
}

export function finalizeCaptureStoreAsync(
  store: AsyncDebugProxyCaptureStore,
  finalizingStore: AsyncDebugProxyCaptureStore,
): Promise<void> {
  const existing = asyncFinalizations.get(store);
  if (existing) {
    return existing;
  }
  if (closed.has(store)) {
    return Promise.resolve();
  }
  const completion = createDeferredCore();
  asyncFinalizations.set(store, completion.promise);
  closed.add(store);
  const callbacks = [...(finalizers.get(store) ?? []), ...(asyncFinalizers.get(store) ?? [])];
  finalizers.delete(store);
  asyncFinalizers.delete(store);
  const pending: Promise<void>[] = [];
  const errors: unknown[] = [];
  for (const finalize of callbacks) {
    try {
      pending.push(Promise.resolve(finalize(finalizingStore)));
    } catch (error) {
      errors.push(error);
    }
  }
  void Promise.allSettled(pending).then((results) => {
    for (const result of results) {
      if (result.status === "rejected") {
        errors.push(result.reason);
      }
    }
    if (errors.length) {
      completion.reject(new AggregateError(errors, "Capture store finalization failed."));
    } else {
      completion.resolve();
    }
  });
  // Finalizers may also be driven from callback-owned teardown; preserve their rejection.
  void completion.promise.catch(() => undefined);
  return completion.promise;
}

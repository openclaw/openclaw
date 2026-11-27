/**
 * Work holding a plugin instance that wants to know when a reload reserves it,
 * so it can yield at its next safe point instead of holding the reload's drain.
 * The instance announces each new reservation; holders watch by instance.
 */
const watchersByInstance = new WeakMap<object, Set<() => void>>();

/**
 * Watch an instance for its next reservation. Work retained while a reload is
 * already pending is told on the next microtask. Returns the unwatch.
 */
export function watchPluginReplacement(
  instance: { readonly replacementPending: boolean },
  onRequested: () => void,
): () => void {
  let watchers = watchersByInstance.get(instance);
  if (!watchers) {
    watchers = new Set();
    watchersByInstance.set(instance, watchers);
  }
  watchers.add(onRequested);
  const current = watchers;
  if (instance.replacementPending) {
    queueMicrotask(() => {
      if (current.has(onRequested)) {
        notifyReplacementRequested(onRequested);
      }
    });
  }
  return () => current.delete(onRequested);
}

/** Called by the instance as a reload reserves it; repeat reservations of a pending reload stay quiet. */
export function announcePluginReplacement(instance: object, alreadyPending: boolean): void {
  if (!alreadyPending) {
    watchersByInstance.get(instance)?.forEach(notifyReplacementRequested);
  }
}

// A watcher belongs to the work holding the instance; its failure never blocks the reload.
function notifyReplacementRequested(onRequested: () => void): void {
  try {
    onRequested();
  } catch {
    // The holder keeps its custody and the reload's drain reports it as usual.
  }
}

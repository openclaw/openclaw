// Only proven immutable graphs enter this set; their lifetime follows the snapshot.
const immutableSnapshots = new WeakSet<object>();

/** Owned envelopes contain data properties; their nested values still belong to producers. */
export function cloneDiagnosticValueForListener<T extends object>(value: T, owned = false): T {
  if (immutableSnapshots.has(value)) {
    return value;
  }
  if (
    owned &&
    Object.getOwnPropertySymbols(value).length === 0 &&
    Object.values(value).every((nested) => isImmutableDiagnosticValue(nested))
  ) {
    immutableSnapshots.add(value);
    return Object.freeze(value);
  }
  return freezeOwnedDiagnosticSnapshot(structuredClone(value));
}

/** Takes ownership of a data graph assembled by core telemetry producers. */
export function freezeOwnedDiagnosticSnapshot<T extends object>(snapshot: T): T {
  if (freezeDiagnosticValue(snapshot, new WeakSet())) {
    immutableSnapshots.add(snapshot);
  }
  return snapshot;
}

/** Capture lazily so filtered listeners never read the producer's payload. */
export function createDiagnosticValueForListeners<T extends object>(
  value: T,
  owned = false,
): () => T {
  let shared: T | undefined;
  return () => {
    if (shared) {
      return shared;
    }
    const snapshot = cloneDiagnosticValueForListener(value, owned);
    if (immutableSnapshots.has(snapshot)) {
      shared = snapshot;
    }
    return snapshot;
  };
}

function isImmutableDiagnosticValue(value: unknown, seen?: WeakSet<object>): boolean {
  if (!value || typeof value !== "object") {
    return typeof value !== "function" && typeof value !== "symbol";
  }
  if (immutableSnapshots.has(value) || seen?.has(value)) {
    return true;
  }
  const prototype = Object.getPrototypeOf(value);
  if (
    !Object.isFrozen(value) ||
    (prototype !== Object.prototype && prototype !== Array.prototype && prototype !== null)
  ) {
    return false;
  }
  let visited = seen;
  return Reflect.ownKeys(value).every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    // Frozen getters can still return mutable data; only plain data is shareable.
    if (typeof key === "symbol" || !("value" in descriptor)) {
      return false;
    }
    if (descriptor.value && typeof descriptor.value === "object") {
      (visited ??= new WeakSet()).add(value);
    }
    return isImmutableDiagnosticValue(descriptor.value, visited);
  });
}

function freezeDiagnosticValue(value: unknown, seen: WeakSet<object>): boolean {
  if (!value || typeof value !== "object" || immutableSnapshots.has(value) || seen.has(value)) {
    return true;
  }
  // Nonempty typed arrays cannot be frozen; keep buffer views listener-local.
  if (ArrayBuffer.isView(value)) {
    return false;
  }
  seen.add(value);
  // Cloned plain graphs are immutable after freezing; Map/Date/etc. retain
  // mutable internals and must keep their individual listener copies.
  const prototype = Object.getPrototypeOf(value);
  let shareable =
    prototype === Object.prototype || prototype === Array.prototype || prototype === null;
  for (const nested of Object.values(value)) {
    if (!freezeDiagnosticValue(nested, seen)) {
      shareable = false;
    }
  }
  Object.freeze(value);
  return shareable;
}

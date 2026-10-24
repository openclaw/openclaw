export function createDiagnosticMetadataForListener<T extends object>(metadata: T): Readonly<T> {
  return Object.freeze({ ...metadata });
}

export function cloneDiagnosticValueForListener<T extends object>(value: T): T {
  return deepFreezeDiagnosticValue(structuredClone(value));
}

/** Capture lazily so filtered listeners never read the producer's payload. */
export function createDiagnosticValueForListeners<T extends object>(value: T): () => T {
  let shared: T | undefined;
  return () => {
    if (shared) {
      return shared;
    }
    const snapshot = structuredClone(value);
    if (freezeDiagnosticValue(snapshot, new WeakSet())) {
      shared = snapshot;
    }
    return snapshot;
  };
}

export function deepFreezeDiagnosticValue<T>(value: T): T {
  freezeDiagnosticValue(value, new WeakSet());
  return value;
}

function freezeDiagnosticValue(value: unknown, seen: WeakSet<object>): boolean {
  if (!value || typeof value !== "object" || seen.has(value)) {
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

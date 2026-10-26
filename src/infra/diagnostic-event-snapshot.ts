import {
  isInternalDiagnosticEventInterested,
  type InternalDiagnosticEventInterest,
} from "./diagnostic-event-listener-presence.js";
import {
  getActiveDiagnosticTraceContext,
  type DiagnosticTraceContext,
} from "./diagnostic-trace-context.js";
import { isBlockedObjectKey } from "./prototype-keys.js";

export type DiagnosticBaseEvent = {
  ts: number;
  seq: number;
  trace?: DiagnosticTraceContext;
};

export type DiagnosticEventMetadata = Readonly<{
  internal?: boolean;
  trustedTraceContext?: boolean;
  trusted: boolean;
}>;

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
  const snapshot = structuredClone(value);
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
  const visited = seen ?? new WeakSet();
  visited.add(value);
  return Reflect.ownKeys(value).every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    // Frozen getters can still return mutable data; only plain data is shareable.
    return (
      typeof key !== "symbol" &&
      "value" in descriptor &&
      isImmutableDiagnosticValue(descriptor.value, visited)
    );
  });
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

export function enrichDiagnosticEvent<const T extends object>(
  state: { seq: number },
  event: T,
  captureActiveTrace = true,
): T & DiagnosticBaseEvent {
  // SAFETY: The owned envelope receives producer fields and required metadata before it escapes.
  const enriched = {} as DiagnosticBaseEvent & Record<string, unknown>;
  // SAFETY: Dispatcher inputs are event records; blocked keys are excluded during the copy.
  for (const [key, value] of Object.entries(event as Record<string, unknown>)) {
    if (isBlockedObjectKey(key)) {
      continue;
    }
    enriched[key] = value;
  }
  if (captureActiveTrace) {
    enriched.trace ??= getActiveDiagnosticTraceContext();
  }
  state.seq += 1;
  enriched.seq = state.seq;
  enriched.ts = Date.now();
  // SAFETY: The producer fields have been copied and the dispatcher metadata is now populated.
  return enriched as T & DiagnosticBaseEvent;
}

export function captureQueuedDiagnosticEvent(
  entry: {
    event: { type: string };
    metadata: DiagnosticEventMetadata;
    privateData?: object;
    trustedListenersOnly?: boolean;
  },
  interests: Iterable<
    | (InternalDiagnosticEventInterest & {
        includePrivateData?: boolean;
      })
    | undefined
  >,
): boolean {
  try {
    let interested = false;
    let includePrivateData = false;
    if (entry.privateData || entry.trustedListenersOnly) {
      for (const interest of interests) {
        if (
          isInternalDiagnosticEventInterested(interest, entry.event.type, entry.metadata.trusted)
        ) {
          interested = true;
          if (interest?.includePrivateData !== false) {
            includePrivateData = true;
            break;
          }
        }
      }
    }
    if (entry.trustedListenersOnly && !interested) {
      return false;
    }
    entry.event = cloneDiagnosticValueForListener(entry.event, true);
    if (entry.privateData) {
      try {
        entry.privateData = includePrivateData
          ? cloneDiagnosticValueForListener(entry.privateData)
          : undefined;
      } catch (error) {
        entry.privateData = undefined;
        console.error(
          `[diagnostic-events] private snapshot error type=${entry.event.type}: ${String(error)}`,
        );
      }
    }
    return true;
  } catch (error) {
    console.error(
      `[diagnostic-events] queue snapshot error type=${entry.event.type}: ${String(error)}`,
    );
    return false;
  }
}

/** Returns whether listener metadata marks dispatcher-internal provenance. */
export function isInternalDiagnosticEventMetadata(metadata: DiagnosticEventMetadata): boolean {
  return metadata.internal === true;
}

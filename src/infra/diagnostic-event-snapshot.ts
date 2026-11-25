import {
  isInternalDiagnosticEventInterested,
  type InternalDiagnosticEventInterest,
} from "./diagnostic-event-listener-presence.js";
import {
  getActiveDiagnosticTraceContext,
  type DiagnosticTraceContext,
} from "./diagnostic-trace-context.js";
import { cloneDiagnosticValueForListener } from "./diagnostic-value-snapshot.js";
import { isBlockedObjectKey } from "./prototype-keys.js";

export { cloneDiagnosticValueForListener };
export { createDiagnosticValueForListeners } from "./diagnostic-value-snapshot.js";

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

import type {
  DiagnosticEventMetadata,
  DiagnosticEventPayload,
  DiagnosticEventPrivateData,
  TrustedToolExecutionEvent,
} from "./diagnostic-events.js";

export type DiagnosticEventListener = (
  evt: DiagnosticEventPayload,
  metadata: DiagnosticEventMetadata,
) => void;

export type TrustedDiagnosticEventListener = (
  evt: DiagnosticEventPayload,
  metadata: DiagnosticEventMetadata,
  privateData: DiagnosticEventPrivateData,
) => void;

export type TrustedToolExecutionEventListener = (event: TrustedToolExecutionEvent) => void;

export type QueuedDiagnosticEvent = {
  event: DiagnosticEventPayload;
  metadata: DiagnosticEventMetadata;
  privateData?: DiagnosticEventPrivateData;
  trustedListenersOnly?: boolean;
};

export type DiagnosticEventsGlobalState = {
  marker: symbol;
  enabled: boolean;
  seq: number;
  listeners: Set<DiagnosticEventListener>;
  trustedListeners: Set<TrustedDiagnosticEventListener>;
  toolExecutionListeners: Set<TrustedToolExecutionEventListener>;
  toolExecutionSeq: number;
  dispatchDepth: number;
  asyncQueue: QueuedDiagnosticEvent[];
  pendingAsyncRunEventSequences: Map<string, Set<number>>;
  pendingAsyncSessionEventSequences: Map<string, Set<number>>;
  asyncDrainScheduled: boolean;
  asyncDroppedEvents: number;
  asyncDroppedTrustedEvents: number;
  asyncDroppedUntrustedEvents: number;
  asyncDroppedPriorityEvents: number;
};

const DIAGNOSTIC_EVENTS_STATE_KEY = Symbol.for("openclaw.diagnosticEvents.state.v1");

function pendingAsyncRunEventIdentity(
  entry: QueuedDiagnosticEvent,
): { runId: string; sequence: number } | undefined {
  if (!("runId" in entry.event) || typeof entry.event.runId !== "string") {
    return undefined;
  }
  const runId = entry.event.runId.trim();
  return runId ? { runId, sequence: entry.event.seq } : undefined;
}

function pendingAsyncSessionEventIdentity(
  entry: QueuedDiagnosticEvent,
): { sessionId: string; sequence: number } | undefined {
  if (!("sessionId" in entry.event) || typeof entry.event.sessionId !== "string") {
    return undefined;
  }
  const sessionId = entry.event.sessionId.trim();
  return sessionId ? { sessionId, sequence: entry.event.seq } : undefined;
}

export function trackPendingAsyncRunEvent(
  state: DiagnosticEventsGlobalState,
  entry: QueuedDiagnosticEvent,
): void {
  const identity = pendingAsyncRunEventIdentity(entry);
  if (!identity) {
    return;
  }
  const sequences = state.pendingAsyncRunEventSequences.get(identity.runId) ?? new Set<number>();
  sequences.add(identity.sequence);
  state.pendingAsyncRunEventSequences.set(identity.runId, sequences);
}

export function trackPendingAsyncSessionEvent(
  state: DiagnosticEventsGlobalState,
  entry: QueuedDiagnosticEvent,
): void {
  const identity = pendingAsyncSessionEventIdentity(entry);
  if (!identity) {
    return;
  }
  const sequences =
    state.pendingAsyncSessionEventSequences.get(identity.sessionId) ?? new Set<number>();
  sequences.add(identity.sequence);
  state.pendingAsyncSessionEventSequences.set(identity.sessionId, sequences);
}

export function untrackPendingAsyncRunEvent(
  state: DiagnosticEventsGlobalState,
  entry: QueuedDiagnosticEvent,
): void {
  const identity = pendingAsyncRunEventIdentity(entry);
  if (!identity) {
    return;
  }
  const sequences = state.pendingAsyncRunEventSequences.get(identity.runId);
  sequences?.delete(identity.sequence);
  if (sequences?.size === 0) {
    state.pendingAsyncRunEventSequences.delete(identity.runId);
  }
}

export function untrackPendingAsyncSessionEvent(
  state: DiagnosticEventsGlobalState,
  entry: QueuedDiagnosticEvent,
): void {
  const identity = pendingAsyncSessionEventIdentity(entry);
  if (!identity) {
    return;
  }
  const sequences = state.pendingAsyncSessionEventSequences.get(identity.sessionId);
  sequences?.delete(identity.sequence);
  if (sequences?.size === 0) {
    state.pendingAsyncSessionEventSequences.delete(identity.sessionId);
  }
}

function createDiagnosticEventsState(): DiagnosticEventsGlobalState {
  return {
    marker: DIAGNOSTIC_EVENTS_STATE_KEY,
    enabled: true,
    seq: 0,
    listeners: new Set(),
    trustedListeners: new Set(),
    toolExecutionListeners: new Set(),
    toolExecutionSeq: 0,
    dispatchDepth: 0,
    asyncQueue: [],
    pendingAsyncRunEventSequences: new Map(),
    pendingAsyncSessionEventSequences: new Map(),
    asyncDrainScheduled: false,
    asyncDroppedEvents: 0,
    asyncDroppedTrustedEvents: 0,
    asyncDroppedUntrustedEvents: 0,
    asyncDroppedPriorityEvents: 0,
  };
}

function isDiagnosticEventsState(value: unknown): value is DiagnosticEventsGlobalState {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<DiagnosticEventsGlobalState>;
  return (
    candidate.marker === DIAGNOSTIC_EVENTS_STATE_KEY &&
    typeof candidate.enabled === "boolean" &&
    typeof candidate.seq === "number" &&
    candidate.listeners instanceof Set &&
    (candidate.trustedListeners === undefined || candidate.trustedListeners instanceof Set) &&
    (candidate.toolExecutionListeners === undefined ||
      candidate.toolExecutionListeners instanceof Set) &&
    typeof candidate.dispatchDepth === "number" &&
    Array.isArray(candidate.asyncQueue) &&
    typeof candidate.asyncDrainScheduled === "boolean"
  );
}

export function getDiagnosticEventsState(): DiagnosticEventsGlobalState {
  const globalRecord = globalThis as Record<PropertyKey, unknown>;
  const existing = globalRecord[DIAGNOSTIC_EVENTS_STATE_KEY];
  if (isDiagnosticEventsState(existing)) {
    existing.asyncDroppedEvents ??= 0;
    existing.asyncDroppedTrustedEvents ??= 0;
    existing.asyncDroppedUntrustedEvents ??= 0;
    existing.asyncDroppedPriorityEvents ??= 0;
    existing.trustedListeners ??= new Set();
    existing.toolExecutionListeners ??= new Set();
    existing.toolExecutionSeq ??= 0;
    if (!(existing.pendingAsyncRunEventSequences instanceof Map)) {
      existing.pendingAsyncRunEventSequences = new Map();
      for (const entry of existing.asyncQueue) {
        trackPendingAsyncRunEvent(existing, entry);
      }
    }
    if (!(existing.pendingAsyncSessionEventSequences instanceof Map)) {
      existing.pendingAsyncSessionEventSequences = new Map();
      for (const entry of existing.asyncQueue) {
        trackPendingAsyncSessionEvent(existing, entry);
      }
    }
    return existing;
  }
  const state = createDiagnosticEventsState();
  Object.defineProperty(globalThis, DIAGNOSTIC_EVENTS_STATE_KEY, {
    configurable: true,
    enumerable: false,
    value: state,
    writable: false,
  });
  return state;
}

function hasPendingAsyncSequence(
  sequences: Set<number> | undefined,
  throughSequence: number,
  excludingSequence?: number,
): boolean {
  if (!sequences) {
    return false;
  }
  for (const sequence of sequences) {
    if (sequence <= throughSequence && sequence !== excludingSequence) {
      return true;
    }
  }
  return false;
}

/** Checks indexed async diagnostics through a sequence watermark without exposing queue state. */
export function hasPendingInternalDiagnosticOwnerEvent(
  ownerRef: string,
  throughSequence: number,
  identity: "run" | "run-or-session",
  excludingSequence?: number,
): boolean {
  const state = getDiagnosticEventsState();
  if (
    hasPendingAsyncSequence(
      state.pendingAsyncRunEventSequences.get(ownerRef),
      throughSequence,
      excludingSequence,
    )
  ) {
    return true;
  }
  return (
    identity === "run-or-session" &&
    hasPendingAsyncSequence(
      state.pendingAsyncSessionEventSequences.get(ownerRef),
      throughSequence,
      excludingSequence,
    )
  );
}

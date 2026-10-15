/** Process-wide listener counts used to avoid telemetry work without consumers. */
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { notifyListeners } from "../shared/listeners.js";

const DIAGNOSTIC_EVENT_LISTENER_PRESENCE_KEY = Symbol.for(
  "openclaw.diagnosticEventListenerPresence.v1",
);

type DiagnosticEventListenerPresence = {
  broadInterestCount: number;
  eventInterestDeltas: Map<string, number>;
  interestListeners: Map<string, Set<() => void>>;
  marker: symbol;
  internalCount: number;
  trustedCount: number;
};

const listenerPresence = resolveGlobalSingleton<DiagnosticEventListenerPresence>(
  DIAGNOSTIC_EVENT_LISTENER_PRESENCE_KEY,
  () => ({
    broadInterestCount: 0,
    eventInterestDeltas: new Map(),
    interestListeners: new Map(),
    marker: DIAGNOSTIC_EVENT_LISTENER_PRESENCE_KEY,
    internalCount: 0,
    trustedCount: 0,
  }),
);

export type InternalDiagnosticEventInterest<EventType extends string = string> = Readonly<{
  include?: readonly EventType[];
  exclude?: readonly EventType[];
  /** Restricts trusted events only; untrusted events still use include/exclude. */
  includeTrusted?: readonly EventType[];
}>;

export function isInternalDiagnosticEventInterested<EventType extends string>(
  interest: InternalDiagnosticEventInterest<EventType> | undefined,
  type: EventType,
  trusted: boolean,
): boolean {
  return (
    (!interest?.include || interest.include.includes(type)) &&
    !interest?.exclude?.includes(type) &&
    (!trusted || !interest?.includeTrusted || interest.includeTrusted.includes(type))
  );
}

function updateEventInterestDelta(
  state: DiagnosticEventListenerPresence,
  type: string,
  delta: number,
): void {
  const next = (state.eventInterestDeltas.get(type) ?? 0) + delta;
  if (next === 0) {
    state.eventInterestDeltas.delete(type);
  } else {
    state.eventInterestDeltas.set(type, next);
  }
}

export function updateInternalDiagnosticEventInterest(
  interest: InternalDiagnosticEventInterest | undefined,
  delta: 1 | -1,
): void {
  const state = listenerPresence;
  const previouslyUninterested = [...state.interestListeners].filter(
    ([type]) => !hasInternalDiagnosticEventInterest(type),
  );
  const usesIncludeList = Boolean(interest?.include);
  if (!usesIncludeList) {
    state.broadInterestCount += delta;
  }
  const types = usesIncludeList ? interest?.include : (interest?.exclude ?? []);
  for (const type of new Set(types)) {
    if (!usesIncludeList || !interest?.exclude?.includes(type)) {
      updateEventInterestDelta(state, type, usesIncludeList ? delta : -delta);
    }
  }
  for (const [type, listeners] of previouslyUninterested) {
    if (hasInternalDiagnosticEventInterest(type)) {
      notifyListeners(listeners, undefined);
    }
  }
}

export function onInternalDiagnosticEventInterest(type: string, listener: () => void): () => void {
  const state = listenerPresence;
  const listeners = state.interestListeners.get(type) ?? new Set<() => void>();
  state.interestListeners.set(type, listeners);
  listeners.add(listener);
  return () => {
    if (listeners.delete(listener) && listeners.size === 0) {
      state.interestListeners.delete(type);
    }
  };
}

export function hasInternalDiagnosticEventInterest(type: string): boolean {
  const state = listenerPresence;
  return state.broadInterestCount + (state.eventInterestDeltas.get(type) ?? 0) > 0;
}

export function resetInternalDiagnosticEventListenerPresence(): void {
  const state = listenerPresence;
  state.internalCount = 0;
  state.trustedCount = 0;
  state.broadInterestCount = 0;
  state.eventInterestDeltas.clear();
}

export function setInternalDiagnosticEventListenerCounts(
  internalCount: number,
  trustedCount: number,
): void {
  const state = listenerPresence;
  state.internalCount = internalCount;
  state.trustedCount = trustedCount;
}

export function hasInternalDiagnosticEventListeners(): boolean {
  const state = listenerPresence;
  return state.internalCount > 0 || state.trustedCount > 0;
}

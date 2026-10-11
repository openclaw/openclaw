import { randomUUID } from "node:crypto";
import type { SessionGoalOperationResult } from "./goals-operations.types.js";
import type { SessionActorHotState, SessionActorTarget } from "./session-actor-contract.js";
import type {
  SessionInputCompletion,
  SessionPendingInputRow,
} from "./session-pending-input.types.js";
import type { InternalSessionEntry as SessionEntry } from "./types.js";

type SessionActorMemoryGoalReceipt = {
  fingerprint: string;
  expiresAt: number;
  result: SessionGoalOperationResult;
};

/** Incognito data lives with the actor; releasing a caller does not discard it. */
export type SessionActorMemoryWindow = {
  hot: SessionActorHotState;
  events: Array<{ rawSeq: number; event: unknown; eventJson: string }>;
  pendingInputs: Map<string, SessionPendingInputRow>;
  completions: Map<string, SessionInputCompletion>;
  goalReceipts: Map<string, SessionActorMemoryGoalReceipt>;
};

export type SessionActorMemoryState = SessionActorMemoryWindow & {
  /** Only retired windows: the current mutable window is never stored twice. */
  historicalWindows: Map<string, SessionActorMemoryWindow>;
};

export type SessionActorMemoryRecord = { state: SessionActorMemoryState; closed: boolean };

export function advanceSessionActorMemoryState(state: SessionActorMemoryState): void {
  state.hot.version = { ...state.hot.version, sequence: state.hot.version.sequence + 1 };
  state.hot.writeToken = String(state.hot.version.sequence);
  state.hot.dependencySessionIds = [
    ...(state.hot.entry ? [state.hot.entry.sessionId] : []),
    ...state.historicalWindows.keys(),
  ];
  state.hot.pendingInputs = [...state.pendingInputs.values()].map(
    ({ message_json: _message, ...row }) => row,
  );
  state.hot.completionKeys = [...state.completions.keys()];
}

export function emptySessionActorMemoryTranscript(): SessionActorHotState["transcript"] {
  return {
    watermark: { generation: null, maxSeq: null },
    version: { generation: null, rawSeq: null, updatedAt: null },
    anchorsState: "resident",
    anchors: [],
    idempotency: [],
    modelContext: { kind: "resident", entries: [] },
  };
}

/** Callers read this borrowed window; the actor detaches the selected result. */
export function resolveSessionActorMemoryWindow(
  state: SessionActorMemoryState,
  sessionId?: string,
): SessionActorMemoryWindow | undefined {
  return sessionId === undefined || sessionId === state.hot.entry?.sessionId
    ? state
    : state.historicalWindows.get(sessionId);
}

/** Copy current metadata and row collections, retaining immutable historical windows. */
export function cloneSessionActorMemoryState(
  state: SessionActorMemoryState,
): SessionActorMemoryState {
  return {
    hot: structuredClone(state.hot),
    events: [...state.events],
    pendingInputs: new Map(state.pendingInputs),
    completions: new Map(state.completions),
    goalReceipts: new Map(state.goalReceipts),
    historicalWindows: new Map(state.historicalWindows),
  };
}

/** Rotate within the same logical owner, preserving old transcript and custody rows. */
export function selectSessionActorMemoryWindow(
  state: SessionActorMemoryState,
  nextEntry: SessionEntry,
): void {
  const previousId = state.hot.entry?.sessionId;
  if (previousId === nextEntry.sessionId) {
    state.hot.entry = structuredClone(nextEntry);
    return;
  }
  if (previousId) {
    state.historicalWindows.set(previousId, {
      hot: state.hot,
      events: state.events,
      pendingInputs: state.pendingInputs,
      completions: state.completions,
      goalReceipts: state.goalReceipts,
    });
  }
  const selected = state.historicalWindows.get(nextEntry.sessionId);
  state.historicalWindows.delete(nextEntry.sessionId);
  state.hot = {
    ...state.hot,
    entry: structuredClone(nextEntry),
    transcript: selected
      ? structuredClone(selected.hot.transcript)
      : emptySessionActorMemoryTranscript(),
    pendingInputs: selected ? structuredClone(selected.hot.pendingInputs) : [],
    completionKeys: selected ? [...selected.hot.completionKeys] : [],
  };
  state.events = selected ? [...selected.events] : [];
  state.pendingInputs = new Map(selected?.pendingInputs);
  state.completions = new Map(selected?.completions);
  state.goalReceipts = new Map(selected?.goalReceipts);
}

export function createSessionActorMemoryState(target: SessionActorTarget): SessionActorMemoryState {
  return {
    hot: {
      target,
      version: { epoch: randomUUID(), sequence: 0 },
      writeToken: "0",
      dependencySessionIds: [],
      entry: undefined,
      participants: [],
      members: [],
      pendingInputs: [],
      completionKeys: [],
      transcript: emptySessionActorMemoryTranscript(),
    },
    events: [],
    pendingInputs: new Map(),
    completions: new Map(),
    goalReceipts: new Map(),
    historicalWindows: new Map(),
  };
}

import { randomUUID } from "node:crypto";
import type { SessionActorMemoryBoard } from "../../boards/session-actor-board-contract.js";
import type { SessionActorMemoryProgressCard } from "../../session-cards/session-actor-progress-card-contract.js";
import type { SessionGoalOperationResult } from "./goals-operations.types.js";
import type { SessionActorHotState, SessionActorTarget } from "./session-actor-contract.js";
import {
  createSessionActorMemoryCollaborationState,
  cloneSessionActorMemoryCollaborationState,
  type SessionActorMemoryCollaborationState,
} from "./session-actor-memory-collaboration-state.js";
import type { SessionActorMemoryConversationLink } from "./session-actor-memory-conversation-contract.js";
import type { SessionActorMemoryWorkerTranscriptLedger } from "./session-actor-memory-reports-contract.js";
import {
  createSessionActorMemorySideEffects,
  cloneSessionActorMemorySideEffects,
  type SessionActorMemorySideEffectsState,
} from "./session-actor-memory-side-effects-contract.js";
import type { SessionActorMemoryUsageRollup } from "./session-actor-memory-usage-contract.js";
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
  usageRollup?: SessionActorMemoryUsageRollup;
  sourceCreatedAt?: number;
  conversationLinks: Map<string, SessionActorMemoryConversationLink>;
  primaryConversationRef?: string;
  workerTranscriptCommits: Map<number, SessionActorMemoryWorkerTranscriptLedger>;
  events: Array<{
    rawSeq: number;
    event: unknown;
    eventJson: string;
    createdAt?: number;
    searchOrder?: number;
  }>;
  pendingInputs: Map<string, SessionPendingInputRow>;
  completions: Map<string, SessionInputCompletion>;
  goalReceipts: Map<string, SessionActorMemoryGoalReceipt>;
};

export type SessionActorMemoryState = SessionActorMemoryWindow &
  SessionActorMemorySideEffectsState & {
    collaboration: SessionActorMemoryCollaborationState;
    board?: SessionActorMemoryBoard;
    progressCard?: SessionActorMemoryProgressCard;
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
  state.hot.hasBoard = Boolean(state.board?.snapshot.tabs.length);
  state.hot.pendingInputs = [...state.pendingInputs.values()].map(
    ({ message_json: _message, ...row }) => row,
  );
  state.hot.completionKeys = [...state.completions.keys()];
}

function emptySessionActorMemoryTranscript(): SessionActorHotState["transcript"] {
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
  return sessionId === undefined || !state.hot.entry || sessionId === state.hot.entry.sessionId
    ? state
    : state.historicalWindows.get(sessionId);
}

/** Copy current metadata and row collections, retaining immutable historical windows. */
export function cloneSessionActorMemoryState(
  state: SessionActorMemoryState,
): SessionActorMemoryState {
  return {
    hot: structuredClone(state.hot),
    collaboration: cloneSessionActorMemoryCollaborationState(state.collaboration),
    ...cloneSessionActorMemorySideEffects(state),
    board: state.board,
    progressCard: state.progressCard,
    usageRollup: state.usageRollup,
    sourceCreatedAt: state.sourceCreatedAt,
    conversationLinks: new Map(state.conversationLinks),
    primaryConversationRef: state.primaryConversationRef,
    workerTranscriptCommits: new Map(state.workerTranscriptCommits),
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
      usageRollup: state.usageRollup,
      sourceCreatedAt: state.sourceCreatedAt,
      conversationLinks: state.conversationLinks,
      primaryConversationRef: state.primaryConversationRef,
      workerTranscriptCommits: state.workerTranscriptCommits,
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
  state.usageRollup = selected?.usageRollup;
  state.sourceCreatedAt = selected?.sourceCreatedAt;
  state.conversationLinks = new Map(selected?.conversationLinks);
  state.primaryConversationRef = selected?.primaryConversationRef;
  state.workerTranscriptCommits = new Map(selected?.workerTranscriptCommits);
  state.events = selected ? [...selected.events] : [];
  state.pendingInputs = new Map(selected?.pendingInputs);
  state.completions = new Map(selected?.completions);
  state.goalReceipts = new Map(selected?.goalReceipts);
}

export function createSessionActorMemoryState(target: SessionActorTarget): SessionActorMemoryState {
  return {
    collaboration: createSessionActorMemoryCollaborationState(),
    ...createSessionActorMemorySideEffects(),
    hot: {
      target,
      version: { epoch: randomUUID(), sequence: 0 },
      writeToken: "0",
      dependencySessionIds: [],
      entry: undefined,
      hasBoard: false,
      participants: [],
      members: [],
      pendingInputs: [],
      completionKeys: [],
      transcript: emptySessionActorMemoryTranscript(),
    },
    events: [],
    conversationLinks: new Map(),
    workerTranscriptCommits: new Map(),
    pendingInputs: new Map(),
    completions: new Map(),
    goalReceipts: new Map(),
    historicalWindows: new Map(),
  };
}

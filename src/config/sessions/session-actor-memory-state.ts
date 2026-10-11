import type { SessionGoalOperationResult } from "./goals-operations.types.js";
import type { SessionActorHotState } from "./session-actor-contract.js";
import type {
  SessionInputCompletion,
  SessionPendingInputRow,
} from "./session-pending-input.types.js";

type SessionActorMemoryGoalReceipt = {
  fingerprint: string;
  expiresAt: number;
  result: SessionGoalOperationResult;
};

/** Incognito data lives with the actor; releasing a caller does not discard it. */
export type SessionActorMemoryState = {
  hot: SessionActorHotState;
  events: Array<{ rawSeq: number; event: unknown; eventJson: string }>;
  pendingInputs: Map<string, SessionPendingInputRow>;
  completions: Map<string, SessionInputCompletion>;
  goalReceipts: Map<string, SessionActorMemoryGoalReceipt>;
};

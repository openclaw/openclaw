import type { SessionsGoalMutationResult } from "../../../packages/gateway-protocol/src/schema/sessions-goal.js";

type SessionGoalOperationIdentity = {
  operationId: string;
  issuedAtMs: number;
  /** Hash of the complete immutable request, including the requested session generation. */
  requestFingerprint: string;
};

export type SessionGoalOperation = SessionGoalOperationIdentity &
  (
    | { action: "start"; objective: string; tokenBudget?: number }
    | { action: "edit"; goalId: string; objective: string }
    | { action: "resume" | "pause" | "block" | "complete"; goalId: string; note?: string }
    | { action: "clear"; goalId: string }
  );

export type SessionGoalOperationResult = Omit<SessionsGoalMutationResult, "replayed">;

export type SessionGoalOperationErrorCode =
  | "expired"
  | "operation-conflict"
  | "session-rebound"
  | "goal-rebound"
  | "capacity"
  | "receipt-invalid"
  | "invalid";

export type SessionGoalOperationLookup = {
  sessionKey: string;
  expectedSessionId: string;
  operation: SessionGoalOperation;
};

export type SessionGoalOperationLookupResult =
  | { receipt: SessionGoalOperationResult | undefined }
  | { error: { code: SessionGoalOperationErrorCode; message: string } };

/** Closed session mutation admitted together with its transcript and lifecycle state. */
export type SessionTranscriptTurnMutation = {
  kind: "goal";
  /** Private live authority; never serialized into operation fingerprints or receipts. */
  assertCurrent?: () => void;
  operation: SessionGoalOperation & { action: "start" | "resume" };
  runId: string;
};

export type SessionTranscriptTurnMutationResult = {
  result: SessionGoalOperationResult;
  replayed: boolean;
};

import type { SessionsGoalMutationResult } from "../../../packages/gateway-protocol/src/schema/sessions-goal.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import type {
  GoalRecoveryDecisionAdmission,
  GoalRecoveryIntent,
  GoalRecoveryIssuerAdmission,
} from "./main-session-recovery.types.js";

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

export const SESSION_GOAL_OPERATION_ERROR_CODES = [
  "expired",
  "operation-conflict",
  "session-rebound",
  "goal-rebound",
  "capacity",
  "receipt-invalid",
  "recovery-decision-changed",
  "recovery-decision-caller",
  "invalid",
] as const;

export type SessionGoalOperationErrorCode = (typeof SESSION_GOAL_OPERATION_ERROR_CODES)[number];

export class SessionGoalOperationError extends Error {
  readonly code: SessionGoalOperationErrorCode;

  constructor(code: SessionGoalOperationErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "SessionGoalOperationError";
  }
}

export type SessionGoalOperationLookup = {
  sessionKey: string;
  expectedSessionId: string;
  operation: SessionGoalOperation;
};

export type SessionGoalOperationLookupResult =
  | { receipt: SessionGoalOperationResult | undefined }
  | { error: { code: SessionGoalOperationErrorCode; message: string } };

/** Live reviewed recovery assertions remain on the host through native settlement. */
export type GoalRecoveryInputAdmission = {
  operation: SessionGoalOperation & { action: "resume" };
  decision: GoalRecoveryDecisionAdmission;
  issuer: GoalRecoveryIssuerAdmission;
};

export type AcceptedGoalRecoveryInput = {
  operation: GoalRecoveryInputAdmission["operation"];
  decision: Omit<GoalRecoveryDecisionAdmission, "assertCurrent">;
  intent: GoalRecoveryIntent;
};

/** Closed session mutation admitted together with its transcript and lifecycle state. */
export type SessionTranscriptTurnMutation = {
  kind: "goal";
  /** Private live authority; never serialized into operation fingerprints or receipts. */
  assertCurrent?: () => void;
  routingPredicate?: {
    config: OpenClawConfig;
    key: string;
    agentId: string;
    storePath: string;
    canonicalKey: string;
  };
  issuerAdmission?: GoalRecoveryIssuerAdmission;
  operation: SessionGoalOperation & { action: "start" | "resume" };
  runId: string;
};

export type SessionTranscriptTurnMutationResult = {
  result: SessionGoalOperationResult;
  replayed: boolean;
};

import type {
  SessionGoalManagementCommit,
  SessionGoalManagementInput,
  SessionGoalOperationLookup,
  SessionGoalOperationResult,
} from "./goals-operations.types.js";
import type {
  PendingInputHistoryQuery,
  PendingInputHistoryReceipt,
  PendingInputHistorySnapshot,
} from "./session-pending-input-history.types.js";
import type {
  PendingInputMutation,
  PendingInputMutationReceipt,
  PendingInputRead,
  PendingInputSnapshot,
  PendingInputSourceSnapshot,
} from "./session-pending-input-operations.types.js";
import type { projectPendingInputReceipts } from "./session-pending-input-value.js";

export type SessionActorMemoryPendingReads = {
  "session.pendingInput.read": {
    input: PendingInputRead;
    output: PendingInputSnapshot | PendingInputSourceSnapshot;
  };
  "session.pendingInput.history": {
    input: PendingInputHistoryQuery;
    output: PendingInputHistorySnapshot;
  };
  "session.pendingInput.receipts": {
    input: { sessionKey: string; sessionId: string; runIds: readonly string[] };
    output: ReturnType<typeof projectPendingInputReceipts>;
  };
  "session.goal.receipt": {
    input: SessionGoalOperationLookup;
    output: SessionGoalOperationResult | undefined;
  };
};

export type SessionActorMemoryPendingWrites = {
  "session.pendingInput.mutate": {
    input: PendingInputMutation;
    output: PendingInputMutationReceipt;
  };
  "session.pendingInput.interruptHistory": {
    input: { sessionKey: string; sessionId: string; ids: string[] };
    output: PendingInputHistoryReceipt;
  };
  "session.goal.mutate": { input: SessionGoalManagementInput; output: SessionGoalManagementCommit };
};

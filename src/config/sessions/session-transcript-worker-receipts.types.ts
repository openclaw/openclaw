import type {
  ConversationDeliveryLookup,
  ConversationDeliveryRecord,
} from "./conversation-delivery-store.types.js";
import type {
  SessionGoalOperationLookup,
  SessionGoalOperationLookupResult,
} from "./goals-operations.types.js";
import type { listSessionPendingInputReceipts } from "./session-accessor.sqlite-pending-input-receipts.js";
import type { SessionQuestionReadInput, SessionQuestionResult } from "./session-questions.types.js";

type SessionPendingInputReceiptsWorkerInput = {
  kind: "session-pending-input-receipts";
  database: { agentId: string; path: string };
  agentId: string;
  sessionKey: string;
  sessionId: string;
  runIds: readonly string[];
  env: NodeJS.ProcessEnv;
};

type ConversationDeliveryWorkerInput = {
  kind: "conversation-delivery";
  database: { agentId: string; path: string };
  env: NodeJS.ProcessEnv;
  lookup: ConversationDeliveryLookup;
};

type SessionGoalOperationReceiptWorkerInput = SessionGoalOperationLookup & {
  kind: "goal-operation-receipt";
  database: { agentId: string; path: string };
  env: NodeJS.ProcessEnv;
};

/** Canonical receipt reads share one history-worker wire boundary. */
export type SessionTranscriptReceiptWorkerInput =
  | ConversationDeliveryWorkerInput
  | SessionGoalOperationReceiptWorkerInput
  | SessionPendingInputReceiptsWorkerInput
  | SessionQuestionReadInput;
export type SessionTranscriptReceiptWorkerValues = {
  "conversation-delivery": { kind: "conversation-delivery"; record?: ConversationDeliveryRecord };
  "goal-operation-receipt": {
    kind: "goal-operation-receipt";
    result: SessionGoalOperationLookupResult;
  };
  "session-pending-input-receipts": {
    kind: "session-pending-input-receipts";
    receipts: ReturnType<typeof listSessionPendingInputReceipts>;
  };
  "session-question-read": { kind: "session-question-read"; result: SessionQuestionResult };
};
type ReceiptReader<Input, Value> = (input: Omit<Input, "kind" | "database">) => Promise<Value>;
export type SessionTranscriptReceiptReaders = {
  readConversationDelivery: ReceiptReader<
    ConversationDeliveryWorkerInput,
    ConversationDeliveryRecord | undefined
  >;
  readGoalOperationReceipt: ReceiptReader<
    SessionGoalOperationReceiptWorkerInput,
    SessionGoalOperationLookupResult
  >;
  readPendingInputReceipts: ReceiptReader<
    SessionPendingInputReceiptsWorkerInput,
    ReturnType<typeof listSessionPendingInputReceipts>
  >;
  readQuestions: ReceiptReader<SessionQuestionReadInput, SessionQuestionResult>;
};

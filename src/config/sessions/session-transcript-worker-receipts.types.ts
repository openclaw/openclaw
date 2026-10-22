import type { ConversationDeliveryLookup } from "./conversation-delivery-store.types.js";
import type { SessionGoalOperationLookup } from "./goals-operations.types.js";

export type SessionPendingInputReceiptsWorkerInput = {
  kind: "session-pending-input-receipts";
  database: { agentId: string; path: string };
  agentId: string;
  sessionKey: string;
  sessionId: string;
  runIds: readonly string[];
  env: NodeJS.ProcessEnv;
};

export type ConversationDeliveryWorkerInput = {
  kind: "conversation-delivery";
  database: { agentId: string; path: string };
  env: NodeJS.ProcessEnv;
  lookup: ConversationDeliveryLookup;
};

export type SessionGoalOperationReceiptWorkerInput = SessionGoalOperationLookup & {
  kind: "goal-operation-receipt";
  database: { agentId: string; path: string };
  env: NodeJS.ProcessEnv;
};

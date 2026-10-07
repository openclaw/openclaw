export type ConversationDeliveryStatus =
  | "created"
  | "queued"
  | "sent"
  | "suppressed"
  | "rejected"
  | "unknown"
  | "replied";

export type ConversationDeliveryRecord = {
  operationId: string;
  operationKind: "send" | "turn";
  conversationRef: string;
  channel: string;
  sourceSessionKey?: string;
  messageHash: string;
  status: ConversationDeliveryStatus;
  preparedMessageId?: string;
  platformMessageId?: string;
  queueId?: string;
  rejectionError?: string;
  reply?: {
    messageId: string;
    replyToId?: string;
    threadId?: string;
    text: string;
    timestamp: number;
  };
  createdAt: number;
  updatedAt: number;
};

export class ConversationDeliveryInputError extends Error {
  override name = "ConversationDeliveryInputError";
}

export class ConversationDeliveryMissingError extends Error {
  override name = "ConversationDeliveryMissingError";
}

export type ConversationDeliveryInput = {
  operationKind: ConversationDeliveryRecord["operationKind"];
  conversationRef: string;
  sourceSessionKey?: string;
  message: string;
};

export type ConversationDeliveryBegin = ConversationDeliveryInput & {
  operationId: string;
  preparedMessageId?: string;
};

export type ConversationDeliveryTransition = {
  operationId: string;
  status: ConversationDeliveryStatus;
  queueId?: string | null;
  platformMessageId?: string | null;
  rejectionError?: string | null;
  reply?: ConversationDeliveryRecord["reply"];
  allowedFrom: readonly ConversationDeliveryStatus[];
  session?: { sessionKey: string; sessionId: string; lifecycleRevision?: string };
};

export type ConversationDeliveryLookup =
  | { operationId: string; expectedInput?: ConversationDeliveryInput }
  | { conversationRef: string; replyToId: string };

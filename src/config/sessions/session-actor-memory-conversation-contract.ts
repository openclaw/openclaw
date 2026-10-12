import type {
  ConversationDeliveryBegin,
  ConversationDeliveryLookup,
  ConversationDeliveryRecord,
  ConversationDeliveryTransition,
} from "./conversation-delivery-store.types.js";
import type { ConversationIdentity } from "./conversation-identity.js";
import type { ConversationReadQuery, ConversationRecord } from "./conversation-registry.types.js";
export type SessionActorMemoryConversationReads = {
  "session.conversation.read": { input: ConversationReadQuery; output: ConversationRecord[] };
  "session.conversation.authority": {
    input: { conversationRef: string } | { operationId: string };
    output: {
      operation: { conversationRef: string } | undefined;
      conversation: ConversationRecord | undefined;
    };
  };
  "session.conversation.delivery.read": {
    input: ConversationDeliveryLookup;
    output: ConversationDeliveryRecord | undefined;
  };
};
export type SessionActorMemoryConversationWrites = {
  "session.conversation.register": {
    input: {
      identities: readonly ConversationIdentity[];
      discoveredAt: number;
      query?: ConversationReadQuery;
    };
    output: ConversationRecord[] | undefined;
  };
  "session.conversation.delivery.begin": {
    input: ConversationDeliveryBegin;
    output: { created: boolean; record: ConversationDeliveryRecord };
  };
  "session.conversation.delivery.transition": {
    input: ConversationDeliveryTransition;
    output: ConversationDeliveryRecord;
  };
};
export type SessionActorMemoryConversationRegistration = {
  kind: "session.conversation.registration";
  identities: readonly ConversationIdentity[];
  eligible: readonly boolean[];
};

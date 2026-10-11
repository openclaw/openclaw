import type {
  ConversationDeliveryBegin,
  ConversationDeliveryLookup,
  ConversationDeliveryRecord,
  ConversationDeliveryTransition,
} from "./conversation-delivery-store.types.js";
import type { ConversationIdentity } from "./conversation-identity.js";
import type { ConversationReadQuery, ConversationRecord } from "./conversation-registry.types.js";
import type { ConversationRouteContext } from "./conversation-route-context.js";

export type SessionActorMemoryConversationLink = {
  role: "participant" | "primary" | "related";
  firstSeenAt: number;
  lastSeenAt: number;
  routeContext?: ConversationRouteContext;
  routeContextObserved?: true;
};
export type SessionActorMemoryConversationAddress = {
  identity: ConversationIdentity;
  firstSeenAt: number;
  lastSeenAt: number;
};
/** As in the durable owner, deleting a session removes its links; catalog/delivery facts live until this memory owner closes. */
export type SessionActorMemoryConversationOwner = {
  catalog: Map<string, SessionActorMemoryConversationAddress>;
  deliveries: Map<string, ConversationDeliveryRecord>;
};
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
export type SessionActorMemoryConversationQuery = {
  [Key in keyof SessionActorMemoryConversationReads]: {
    type: Key;
    input: SessionActorMemoryConversationReads[Key]["input"];
  };
}[keyof SessionActorMemoryConversationReads];
export type SessionActorMemoryConversationCommand = {
  [Key in keyof SessionActorMemoryConversationWrites]: {
    type: Key;
    input: SessionActorMemoryConversationWrites[Key]["input"];
  };
}[keyof SessionActorMemoryConversationWrites];

export type SessionActorMemoryConversationRegistration = {
  kind: "session.conversation.registration";
  identities: readonly ConversationIdentity[];
  eligible: readonly boolean[];
};

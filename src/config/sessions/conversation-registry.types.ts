import type { ChatType as ConversationKind } from "../../channels/chat-type.js";
import type { ConversationRouteContext } from "./conversation-route-context.js";

export type ConversationRecord = {
  conversationRef: string;
  channel: string;
  accountId: string;
  kind: ConversationKind;
  peerId: string;
  target: string;
  parentConversationRef?: string;
  threadId?: string;
  nativeChannelId?: string;
  nativeDirectUserId?: string;
  label?: string;
  sessionId?: string;
  sessionKey?: string;
  role?: "participant" | "primary" | "related";
  /** True when this address has been linked to a session in this agent store. */
  observedFromSession?: true;
  /** Exact contextual facts from the authoritative inbound route. */
  routeContext?: ConversationRouteContext;
  /** True when authoritative ingress observed empty or populated route context. */
  routeContextObserved?: true;
  firstSeenAt: number;
  lastSeenAt: number;
};

export type ConversationReadQuery = {
  channel?: string;
  deliveryAddress?: { accountId: string; target: string; threadId?: string };
  conversationRef?: string;
  conversationRefs?: readonly string[];
  limit?: number;
  primarySession?: { sessionId: string; sessionKey: string };
  currentBindingOnly?: boolean;
  currentSession?: { sessionKey: string; sessionId: string };
};

export type ConversationRowsWorkerInput = {
  kind: "conversation-rows";
  database: { agentId: string; path: string };
  query: ConversationReadQuery;
  env: NodeJS.ProcessEnv;
};

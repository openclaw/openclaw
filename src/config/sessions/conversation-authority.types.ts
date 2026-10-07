export type ConversationAuthority = {
  conversationRef: string;
  expectedRouteFingerprint: string;
  expectedSessionId?: string;
  expectedSessionKey?: string;
};

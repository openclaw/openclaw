import type { ConversationRef } from "./session-binding.types.js";

/** Durable proof that an ACP child owned a conversation when its reply was queued. */
export type AcpConversationBindingAuthority = {
  targetSessionKey: string;
  bindingId: string;
  boundAt: number;
  conversation: ConversationRef;
};

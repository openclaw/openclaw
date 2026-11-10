import type { PluginStateActionAuthority } from "../plugin-state/plugin-state-store.types.js";
import type { PluginConversationBinding } from "./conversation-binding.types.js";

declare const bindingCurrentBrand: unique symbol;
/** Host-minted restriction, not a transferable permission or serializable receipt. */
export type PluginConversationBindingCurrent = { readonly [bindingCurrentBrand]: true };

/** Current host requester, session incarnation and exact plugin assignment for one callback. */
export type PluginConversationBindingAuthority = PluginStateActionAuthority & {
  readonly version: 1;
  readonly binding: Readonly<PluginConversationBinding>;
  readonly requester: Readonly<{
    kind: "channel";
    channel: string;
    accountId: string;
    conversationId: string;
    parentConversationId?: string;
    threadId?: string | number;
    senderId: string;
  }>;
  readonly session: Readonly<{ agentId: string; sessionKey: string; sessionId: string }>;
  readonly conversationBindingCurrent: PluginConversationBindingCurrent;
};

export type WithCurrentPluginConversationBinding = <T>(
  action: (authority: PluginConversationBindingAuthority) => Promise<T>,
) => Promise<T>;

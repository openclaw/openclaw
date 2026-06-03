import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  resolveCommandConversationResolution,
  type ResolveCommandConversationResolutionInput,
} from "./conversation-resolution.js";

type ConversationBindingContext = {
  channel: string;
  accountId: string;
  conversationId: string;
  parentConversationId?: string;
  threadId?: string;
};

type ResolveConversationBindingContextInput = Omit<
  ResolveCommandConversationResolutionInput,
  "includePlacementHint"
> & {
  cfg: OpenClawConfig;
};

/**
 * Resolves the canonical channel/account/conversation tuple used for conversation bindings.
 */
export function resolveConversationBindingContext(
  params: ResolveConversationBindingContextInput,
): ConversationBindingContext | null {
  const resolution = resolveCommandConversationResolution({
    ...params,
    // Binding keys must stay canonical; placement hints are only user-facing routing guidance.
    includePlacementHint: false,
  });
  if (!resolution) {
    return null;
  }
  return {
    channel: resolution.canonical.channel,
    accountId: resolution.canonical.accountId,
    conversationId: resolution.canonical.conversationId,
    ...(resolution.canonical.parentConversationId
      ? { parentConversationId: resolution.canonical.parentConversationId }
      : {}),
    ...(resolution.threadId ? { threadId: resolution.threadId } : {}),
  };
}

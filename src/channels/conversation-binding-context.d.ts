import type { OpenClawConfig } from "../config/types.openclaw.js";
import { type ResolveCommandConversationResolutionInput } from "./conversation-resolution.js";
export type ConversationBindingContext = {
    channel: string;
    accountId: string;
    conversationId: string;
    parentConversationId?: string;
    threadId?: string;
};
export type ResolveConversationBindingContextInput = Omit<ResolveCommandConversationResolutionInput, "includePlacementHint"> & {
    cfg: OpenClawConfig;
};
export declare function resolveConversationBindingContext(params: ResolveConversationBindingContextInput): ConversationBindingContext | null;

import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

export type ChannelConversationBindingSupport = {
  supportsCurrentConversationBinding?: boolean;
  isCurrentConversationBindingSupported?: (params: { accountId: string }) => boolean;
  /** Declares that live bindings come from a channel-registered adapter, never generic storage. */
  bindingStore?: "adapter";
  /**
   * Preferred placement when a command is started from a top-level conversation
   * without an existing native thread id.
   *
   * - `current`: bind/spawn in the current conversation
   * - `child`: create a child thread/conversation first
   */
  defaultTopLevelPlacement?: "current" | "child";
  resolveConversationRef?: (params: {
    accountId?: string | null;
    conversationId: string;
    parentConversationId?: string;
    threadId?: string | number | null;
  }) => {
    conversationId: string;
    parentConversationId?: string;
  } | null;
  buildBoundReplyPayload?: (params: {
    operation: "acp-spawn";
    placement: "current" | "child";
    conversation: {
      channel: string;
      accountId?: string | null;
      conversationId: string;
      parentConversationId?: string;
    };
  }) =>
    | Pick<ReplyPayload, "channelData" | "delivery" | "presentation">
    | null
    | Promise<Pick<ReplyPayload, "channelData" | "delivery" | "presentation"> | null>;
  buildModelOverrideParentCandidates?: (params: {
    parentConversationId?: string | null;
  }) => string[] | null | undefined;
  shouldStripThreadFromAnnounceOrigin?: (params: {
    requester: {
      channel?: string;
      to?: string;
      threadId?: string | number;
    };
    entry: {
      channel?: string;
      to?: string;
      threadId?: string | number;
    };
  }) => boolean;
  /** @deprecated Use setIdleTimeoutBySessionKeyAsync. Retained through the next Plugin SDK major. */
  setIdleTimeoutBySessionKey?: (params: {
    targetSessionKey: string;
    accountId?: string | null;
    idleTimeoutMs: number;
  }) => Array<{
    boundAt: number;
    lastActivityAt: number;
    idleTimeoutMs?: number;
    maxAgeMs?: number;
  }>;
  /** @deprecated Use setMaxAgeBySessionKeyAsync. Retained through the next Plugin SDK major. */
  setMaxAgeBySessionKey?: (params: {
    targetSessionKey: string;
    accountId?: string | null;
    maxAgeMs: number;
  }) => Array<{
    boundAt: number;
    lastActivityAt: number;
    idleTimeoutMs?: number;
    maxAgeMs?: number;
  }>;
  setIdleTimeoutBySessionKeyAsync?: (
    params: Parameters<
      NonNullable<ChannelConversationBindingSupport["setIdleTimeoutBySessionKey"]>
    >[0],
  ) => Promise<
    ReturnType<NonNullable<ChannelConversationBindingSupport["setIdleTimeoutBySessionKey"]>>
  >;
  setMaxAgeBySessionKeyAsync?: (
    params: Parameters<NonNullable<ChannelConversationBindingSupport["setMaxAgeBySessionKey"]>>[0],
  ) => Promise<ReturnType<NonNullable<ChannelConversationBindingSupport["setMaxAgeBySessionKey"]>>>;
  createManager?: (params: { cfg: OpenClawConfig; accountId?: string | null }) =>
    | {
        stop: () => void | Promise<void>;
      }
    | Promise<{
        stop: () => void | Promise<void>;
      }>;
};

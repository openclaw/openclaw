import type { BrowserTabSelection } from "../../../components/browser/browser-target.ts";
import type { PersonActivityRouting } from "../../../components/person-activity-link.ts";
import type { MessageGroup } from "../../../lib/chat/chat-types.ts";
import type { renderForwardedAvatar } from "../chat-avatar.ts";
import type { AssistantMessageExpansionState } from "../chat-message-recovery.ts";
import type { TurnRecap } from "../chat-progress.ts";
import type { renderGroupedMessage } from "./chat-message-bubble.ts";
import type { MessageReplyTarget } from "./chat-message-markdown.ts";
import type { MessageReactionOptions } from "./chat-message-reaction-model.ts";
import type { ChatSendStatusActions } from "./chat-message-send-status.ts";
import type { StreamGroupOptions, StreamGroupPart } from "./chat-message-stream.ts";
import type { ReplyLine } from "./chat-reply-attribution.ts";
import type { ReplyPreviewLookup } from "./chat-reply-preview.types.ts";
import type { SidebarContent, SidebarFullMessageLoader } from "./chat-sidebar-content-types.ts";

export type RenderMessageGroupOptions = Omit<
  Parameters<typeof renderGroupedMessage>[2],
  | "isStreaming"
  | "duplicateCount"
  | "assistantMessageDisclosure"
  | "messageActions"
  | "entryId"
  | "entryRef"
  | "replyLine"
> &
  ChatSendStatusActions &
  Parameters<typeof renderForwardedAvatar>[1] & {
    /** A run frame's line, from its final answer; other groups resolve their own. */
    frameReplyLine?: ReplyLine;
    entryRefFor?: (key: string) => ((element?: Element) => void) | undefined;
    latestBrowserTabs?: ReadonlyMap<string, BrowserTabSelection>;
    /** Configured main-session key; an agent's main source labels as the agent. */
    mainKey?: string;
    basePath?: string;
    onOpenSidebar?: (content: SidebarContent) => void;
    loadFullAssistantMessage?: SidebarFullMessageLoader;
    getAssistantMessageExpansion?: (
      messageId: string,
    ) => AssistantMessageExpansionState | undefined;
    onToggleAssistantMessageExpanded?: (messageId: string) => void;
    userId?: string | null;
    userName?: string | null;
    showOwnSenderName?: boolean;
    /** Routing for peer sender names; absent leaves them plain text. */
    personActivity?: PersonActivityRouting;
    userAvatar?: string | null;
    avatarPlacement?: "gutter" | "footer" | "none";
    showAssistantAvatar?: boolean;
    contextWindow?: number | null;
    onReply?: (target: MessageReplyTarget) => void;
    resolveReplyPreview?: ReplyPreviewLookup;
    onRewind?: () => void;
    rewindDisabled?: boolean;
    activeContinuation?: { parts: StreamGroupPart[]; options: StreamGroupOptions };
    /** Only this run may supply live copy for an activity disclosure. */
    activityRunId?: string | null;
    activityGroupKey?: string;
    turnRecap?: TurnRecap;
    /** Frame bodies are pre-rendered by the frame owner; ordinary groups omit them. */
    frameContent?: readonly unknown[];
    frameActionOwner?: MessageGroup["messages"][number] | null;
    latestAssistant?: boolean;
    /** Rendered as a transcript search result, outside its turn. */
    searchResult?: boolean;
  } & MessageReactionOptions;

import type { JSX } from "@solidjs/web";
import type { ToolCallGroup } from "../../../../../src/chat/tool-call-grouping.js";
import type { ImageLightboxItem } from "../../../components/image-lightbox.types.ts";
import type { BoardProvider } from "../../../lib/board/provider.ts";
import type { EmbedSandboxMode } from "../../../lib/chat/canvas-embed-policy.ts";
import type { ToolCard } from "../../../lib/chat/chat-types.ts";
import type { PresentationValue } from "../../../lib/presentation.ts";
import type { PluginToolIcons } from "../chat-tool-icon-controller.ts";
import type { LinkFaviconFetcher } from "../link-favicon-cache.ts";
import type { AsyncQuestionPresentation } from "./chat-async-question.types.ts";
import type { MessageActionDetails } from "./chat-message-markdown.types.ts";
import type { ArtifactDownloadResolver } from "./chat-message-media.ts";
import type { AssistantMessageDisclosure } from "./chat-message-text-preparation.ts";
import type { ReplyLine } from "./chat-reply-attribution.ts";
import type { ToolRenderOptions } from "./chat-tool-render-model.ts";

export type ActivityOperationProps = {
  group: ToolCallGroup<ToolCard>;
  options: Omit<ToolRenderOptions, "messageKey"> &
    Pick<GroupedMessageOptions, "isToolExpanded" | "onToggleToolExpanded">;
  contexts: ReadonlyMap<ToolCard, { messageKey: string; disclosureId: string }>;
};

export type MessageRenderOptions = {
  /** Links a handoff's child sessions; absent where this pane cannot open sessions. */
  handoffSessionLinks?: import("../chat-subagent-wait.ts").HandoffSessionLinks;
  onOpenReply?: (replyToId: string) => void;
  replyNavigationId?: string | null;
  sessionKey?: string;
  presented?: boolean;
  boardProvider?: BoardProvider;
  widgetLayout?: import("../session-message-cache.ts").ChatWidgetLayout;
  agentId?: string;
  runActive?: boolean;
  asyncQuestions?: AsyncQuestionPresentation;
  mediaOwner?: object;
  /** Saved transcript text can render before live resource admission. */
  mediaReadAllowed?: boolean;
  canvasPluginSurfaceUrl?: string | null;
  resourceBasePath?: string;
  mediaPolicyKey?: string;
  connectionEpoch?: number;
  assistantAttachmentAuthToken?: string | null;
  resolveArtifactDownload?: ArtifactDownloadResolver;
  getTurnVideoMessages?: (
    key: string,
  ) => readonly import("./chat-turn-video-gallery.ts").TurnVideoMessage[] | undefined;
  onRequestOpenImage?: () => number;
  onOpenImage?: (item: ImageLightboxItem, requestVersion?: number) => void;
  onAssistantAttachmentLoaded?: () => void;
  embedSandboxMode?: EmbedSandboxMode;
  allowExternalEmbedUrls?: boolean;
  fetchLinkFavicon?: LinkFaviconFetcher;
  pluginToolIcons?: PluginToolIcons;
  onOpenWorkspaceFile?: (target: { path: string; line?: number | null }) => void;
  onPermissionRetry?: (message: string) => void;
};

export type GroupedMessageOptions = MessageRenderOptions & {
  isStreaming: boolean;
  isForwarded?: boolean;
  /** Search reveals matching transcript text inside disclosures. */
  searchResult?: boolean;
  transcriptVisible?: PresentationValue;
  showReasoning: boolean;
  bubbleMode?: boolean;
  /** First visible message of the containing group/frame; null means none. */
  firstBubbleKey?: string | null;
  showToolCalls?: boolean;
  isToolMessageExpanded?: (messageId: string) => boolean | undefined;
  onToggleToolMessageExpanded?: (messageId: string, expanded?: boolean) => void;
  isUserMessageExpanded?: (messageId: string) => boolean;
  onToggleUserMessageExpanded?: (messageId: string) => void;
  assistantMessageDisclosure?: AssistantMessageDisclosure;
  messageActions?: MessageActionDetails | null;
  isToolExpanded?: (toolCardId: string) => boolean;
  onToggleToolExpanded?: (toolCardId: string, expanded?: boolean) => void;
  toolCardOverrides?: ReadonlyMap<ToolCard, ActivityOperationProps | null>;
  subagents?: ToolRenderOptions["subagents"];
  fileLinkSessionKey?: string;
  avatar?: () => JSX.Element;
  entryId?: string;
  /** This message's own "Replying to" line, drawn inside the bubble. */
  replyLine?: ReplyLine;
};

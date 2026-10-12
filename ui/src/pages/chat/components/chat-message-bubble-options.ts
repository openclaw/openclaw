import type { JSX } from "@solidjs/web";
import type { ImageLightboxItem } from "../../../components/image-lightbox.types.ts";
import type { MarkdownRenderOptions } from "../../../components/markdown-render-options.ts";
import type { BoardProvider } from "../../../lib/board/provider.ts";
import type { ToolCard } from "../../../lib/chat/chat-types.ts";
import type { EmbedSandboxMode } from "../../../lib/chat/tool-display.ts";
import type { PresentationValue } from "../../../lit/presentation-binding.ts";
import type { PluginToolIcons } from "../chat-tool-icon-controller.ts";
import type { LinkFaviconFetcher } from "../link-favicon-cache.ts";
import type { AsyncQuestionPresentation } from "./chat-async-question.types.ts";
import type { MessageActionDetails } from "./chat-message-markdown.types.ts";
import type { ArtifactDownloadResolver } from "./chat-message-media.ts";
import type { AssistantMessageDisclosure } from "./chat-message-text-preparation.ts";
import type { ReplyLine } from "./chat-reply-attribution.ts";
import type { ToolRenderOptions } from "./chat-tool-render-model.ts";

export type GroupedMessageOptions = {
  isStreaming: boolean;
  isForwarded?: boolean;
  sessionKey?: string;
  presented?: boolean;
  transcriptVisible?: PresentationValue;
  boardProvider?: BoardProvider;
  widgetLayout?: import("../session-message-cache.ts").ChatWidgetLayout;
  agentId?: string;
  duplicateCount?: number;
  showReasoning: boolean;
  bubbleMode?: boolean;
  /** First visible message of the containing group/frame; null means none. */
  firstBubbleKey?: string | null;
  showToolCalls?: boolean;
  runActive?: boolean;
  asyncQuestions?: AsyncQuestionPresentation;
  isToolMessageExpanded?: (messageId: string) => boolean | undefined;
  onToggleToolMessageExpanded?: (messageId: string, expanded?: boolean) => void;
  isUserMessageExpanded?: (messageId: string) => boolean;
  onToggleUserMessageExpanded?: (messageId: string) => void;
  assistantMessageDisclosure?: AssistantMessageDisclosure;
  messageActions?: MessageActionDetails | null;
  isToolExpanded?: (toolCardId: string) => boolean;
  onToggleToolExpanded?: (toolCardId: string, expanded?: boolean) => void;
  toolCardOverrides?: ReadonlyMap<ToolCard, unknown>;
  onRequestUpdate?: () => void;
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
  githubRepo?: MarkdownRenderOptions["githubRepo"];
  githubRepositories?: MarkdownRenderOptions["githubRepositories"];
  onOpenWorkspaceFile?: (target: { path: string; line?: number | null }) => void;
  subagents?: ToolRenderOptions["subagents"];
  fileLinkSessionKey?: string;
  avatar?: () => JSX.Element;
  entryId?: string;
  /** Freshly submitted user turn: play the one-shot composer entry animation. */
  entryRef?: (element?: Element) => void;
  /** This message's own "Replying to" line, drawn inside the bubble. */
  replyLine?: ReplyLine;
  onOpenReply?: (replyToId: string) => void;
  replyNavigationId?: string | null;
};

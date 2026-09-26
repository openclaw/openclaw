import { readSessionMessageIdentity } from "@openclaw/gateway-client/browser";
import { html, nothing, type TemplateResult } from "lit";
import { ref } from "lit/directives/ref.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { CHAT_PENDING_INPUT_MESSAGE_PREFIX } from "../../../../../packages/gateway-protocol/src/schema/chat-history-constants.js";
import { icons } from "../../../components/icons.ts";
import type { ImageLightboxItem } from "../../../components/image-lightbox.types.ts";
import { parseMarkdownJson } from "../../../components/markdown-json.ts";
import type { MarkdownRenderOptions } from "../../../components/markdown-render-options.ts";
import { toSanitizedMarkdownHtml } from "../../../components/markdown.ts";
import { t } from "../../../i18n/index.ts";
import { registerChatMessageMetadataEnglish } from "../../../i18n/locales/en-chat-message-metadata.ts";
import type { BoardProvider } from "../../../lib/board/provider.ts";
import type { MessageContentItem, ToolCard } from "../../../lib/chat/chat-types.ts";
import { resolveMessageDisplayMarkdown } from "../../../lib/chat/message-display.ts";
import "../../../components/person-reference.ts";
import { extractThinkingCached } from "../../../lib/chat/message-extract.ts";
import {
  isStandaloneToolMessageForDisplay,
  normalizeRoleForGrouping,
} from "../../../lib/chat/message-normalizer.ts";
import {
  extractToolCardsCached,
  formatDistinctCollapsedToolSummaryText,
  formatCollapsedToolPreviewText,
  formatCollapsedToolSummaryText,
  isToolCardError,
} from "../../../lib/chat/tool-cards.ts";
import { type EmbedSandboxMode, resolveToolDisplay } from "../../../lib/chat/tool-display.ts";
import { assistantMessageIsInterrupted } from "../chat-assistant-reply.ts";
import { isPendingSendMessage } from "../chat-thread-items.ts";
import type { PluginToolIcons } from "../chat-tool-icon-controller.ts";
import "./chat-clawhub-card.ts";
import type { LinkFaviconFetcher } from "../link-favicon-loader.ts";
import { workspaceResultConflictFromTranscript } from "../workspace-conflict.ts";
import { readAsyncQuestions, renderAsyncQuestionSummary } from "./chat-async-question.ts";
import type { AsyncQuestionPresentation } from "./chat-async-question.types.ts";
import {
  renderAssistantAttachments,
  renderMessageAttachment,
  renderOmittedMedia,
} from "./chat-message-attachments.ts";
import { renderMessageWorkContext } from "./chat-message-context.ts";
import { renderMessageImages } from "./chat-message-images.ts";
import type {
  ChatMessageRenderPreparation,
  MessageActionDetails,
} from "./chat-message-markdown.ts";
import { prepareChatMessageRender } from "./chat-message-markdown.ts";
import { prepareMarkdownMedia } from "./chat-message-media-markdown.ts";
import {
  projectMessageMedia,
  schedulePairingQrExpiryRefresh,
  type ArtifactDownloadResolver,
} from "./chat-message-media.ts";
import {
  renderMessageJson,
  renderMessageMarkdown,
  type AssistantMessageDisclosure,
} from "./chat-message-text.ts";
import { isSentPastedTextAttachment } from "./chat-pasted-text.ts";
import { renderReplyPreview, type ReplyPreview } from "./chat-reply-preview-render.ts";
import { isSentCommentAttachment } from "./chat-sent-comments.ts";
import type { SidebarContent } from "./chat-sidebar.ts";
import {
  renderToolApprovalReviews,
  renderToolCard,
  renderToolIcon,
  renderPluginToolResult,
  renderToolPreview,
  resolveCollapsedToolDetail,
  shouldToggleSelectableDisclosure,
  syncToolDisclosureOverflow,
} from "./chat-tool-cards.ts";
import {
  renderExpandedToolCardContent,
  renderRawOutputToggle,
  renderToolOutcome,
} from "./chat-tool-content.ts";
import { renderWorkspaceConflictTranscriptMessage } from "./chat-workspace-conflict.ts";

registerChatMessageMetadataEnglish();

function imageMessageIdentity(message: unknown, sessionKey: string | undefined) {
  const identity = readSessionMessageIdentity(message);
  if (identity?.role !== "user" || identity.isImported) {
    return { localSubmission: false };
  }
  if (!identity.id || isPendingSendMessage(message)) {
    return { localSubmission: Boolean(identity.sendId) };
  }
  return identity.id.startsWith(CHAT_PENDING_INPUT_MESSAGE_PREFIX)
    ? {}
    : { canonicalMessageKey: JSON.stringify([sessionKey, identity.id, identity.sequence]) };
}

function renderInlineToolCards(
  toolCards: ToolCard[],
  opts: Omit<Parameters<typeof renderToolCard>[1], "expanded" | "onToggleExpanded"> & {
    isToolExpanded?: (toolCardId: string) => boolean;
    onToggleToolExpanded?: (toolCardId: string, expanded?: boolean) => void;
    toolCardOverrides?: ReadonlyMap<ToolCard, unknown>;
  },
) {
  return html`
    <div class="chat-tools-inline">
      ${toolCards.map((card, index) => {
        if (opts.toolCardOverrides?.has(card)) {
          return opts.toolCardOverrides.get(card);
        }
        const disclosureId = `${opts.messageKey}:toolcard:${index}`;
        const expanded = opts.isToolExpanded?.(disclosureId) ?? false;
        return renderToolCard(card, {
          ...opts,
          expanded,
          onToggleExpanded: opts.onToggleToolExpanded
            ? () => opts.onToggleToolExpanded?.(disclosureId, expanded)
            : () => undefined,
        });
      })}
    </div>
  `;
}

function renderPairingQrExpiryNotices(count: number) {
  if (count === 0) {
    return nothing;
  }
  return html`
    <div class="chat-pairing-qr-notices">
      ${Array.from(
        { length: count },
        () => html`
          <div
            class="chat-assistant-attachment-card chat-assistant-attachment-card--blocked chat-pairing-qr-expired"
          >
            <span class="chat-pairing-qr-expired__icon" aria-hidden="true"
              >${icons.alertTriangle}</span
            >
            <div class="chat-pairing-qr-expired__content">
              <div class="chat-pairing-qr-expired__heading">
                <span class="chat-pairing-qr-expired__title"
                  >${t("chat.pairingQrExpired.title")}</span
                >
                <span class="chat-pairing-qr-expired__badge"
                  >${t("chat.pairingQrExpired.badge")}</span
                >
              </div>
              <div class="chat-assistant-attachment-card__reason">
                ${t("chat.pairingQrExpired.reason")}
              </div>
            </div>
          </div>
        `,
      )}
    </div>
  `;
}

export function renderGroupedMessage(
  preparation: ChatMessageRenderPreparation,
  messageKey: string,
  opts: {
    isStreaming: boolean;
    isForwarded?: boolean;
    sessionKey?: string;
    presented?: boolean;
    transcriptVisible?: boolean;
    boardProvider?: BoardProvider;
    agentId?: string;
    duplicateCount?: number;
    showReasoning: boolean;
    showToolCalls?: boolean;
    runActive?: boolean;
    asyncQuestions?: AsyncQuestionPresentation;
    autoExpandToolCalls?: boolean;
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
    avatar?: TemplateResult | typeof nothing;
    entryId?: string;
    /** Freshly submitted user turn: play the one-shot composer entry animation. */
    entryRef?: (element?: Element) => void;
    resolveReplyPreview?: (replyToId: string) => ReplyPreview | undefined;
    onResolveReply?: (replyToId: string) => void;
    onOpenReply?: (replyToId: string) => void;
    replyNavigationId?: string | null;
  },
  onOpenSidebar?: (content: SidebarContent) => void,
) {
  const disclosure = opts.assistantMessageDisclosure;
  const { message, normalizedMessage, displayMarkdown, humanMentions } =
    disclosure?.expanded && disclosure.message
      ? prepareChatMessageRender(disclosure.message)
      : preparation;
  const m = message as Record<string, unknown>;
  const role = typeof m.role === "string" ? m.role : "unknown";
  const sourceRole = normalizeRoleForGrouping(role);
  const asyncQuestions = opts.asyncQuestions?.submit ? readAsyncQuestions(message) : null;
  const normalizedRole = normalizeRoleForGrouping(normalizedMessage.role);
  const workspaceConflict = workspaceResultConflictFromTranscript(message);
  if (workspaceConflict) {
    return renderWorkspaceConflictTranscriptMessage(workspaceConflict, messageKey, opts.entryId);
  }
  const isToolShell = normalizedRole === "tool";
  const isStandaloneToolMessage = isStandaloneToolMessageForDisplay(message);

  const toolCards = (opts.showToolCalls ?? true) ? extractToolCardsCached(message) : [];
  // Nested cards moved under their parent must not leave empty message shells.
  const hasToolCards = toolCards.some((card) => opts.toolCardOverrides?.get(card) !== nothing);
  const {
    images,
    attachments: visibleAttachments,
    expiredPairingQrCount,
    nextPairingQrExpiresAt,
    orderedContent,
    supplementalImages,
    supplementalAttachments,
  } = projectMessageMedia(message, normalizedMessage.content);
  schedulePairingQrExpiryRefresh(messageKey, nextPairingQrExpiresAt, opts.onRequestUpdate);
  const hasImages = images.length > 0;
  const videoPreviews =
    normalizedRole === "user"
      ? visibleAttachments.filter(
          (item) => item.type === "attachment" && item.attachment.kind === "video",
        )
      : [];
  const cardAttachments = visibleAttachments.filter((item) => !videoPreviews.includes(item));
  const hasUserFiles =
    normalizedRole === "user" &&
    cardAttachments.some(
      (item) =>
        item.attachment.kind === "document" &&
        !isSentCommentAttachment(item) &&
        !isSentPastedTextAttachment(item),
    );
  const imageRenderOptions = {
    galleryImages: images,
    sessionKey: opts.sessionKey,
    agentId: opts.agentId,
    policyKey: opts.mediaPolicyKey,
    ...(hasImages ? imageMessageIdentity(message, opts.sessionKey) : {}),
    connectionEpoch: opts.connectionEpoch,
    resourceBasePath: opts.resourceBasePath,
    authToken: opts.assistantAttachmentAuthToken,
    onRequestUpdate: opts.onRequestUpdate,
    onRequestOpenImage: opts.onRequestOpenImage,
    onOpenImage: opts.onOpenImage,
    resolveArtifactDownload: opts.resolveArtifactDownload,
  };
  const actionText = opts.messageActions?.markdown ?? displayMarkdown;
  const omittedMedia = normalizedMessage.content.filter(
    (item): item is Extract<MessageContentItem, { type: "omitted_media" }> =>
      item.type === "omitted_media",
  );
  const assistantViewBlocks = normalizedMessage.content.filter(
    (item): item is Extract<MessageContentItem, { type: "canvas" }> => item.type === "canvas",
  );
  const clawHubCards = normalizedMessage.content.filter((item) => item.type === "clawhub");
  const extractedThinking =
    opts.showReasoning && role === "assistant" ? extractThinkingCached(message) : null;
  const reasoningMarkdown = extractedThinking ? `_Reasoning:_\n\n${extractedThinking}` : null;
  const markdown =
    (normalizedRole === "user" ? opts.messageActions?.markdown : undefined) ??
    (displayMarkdown || null);
  const markdownRenderOptions: MarkdownRenderOptions = {
    assistantTranscriptRoleHeaders: role === "assistant",
    codeBlockChrome: role === "user" ? "none" : "copy",
    codeBlockInteraction: role === "assistant" ? "interactive" : "static",
    fileLinks: true,
    githubRepo: role === "assistant" ? (opts.githubRepo ?? null) : null,
    humanMentions: markdown === displayMarkdown ? humanMentions : undefined,
    ...(role === "assistant" && opts.githubRepositories
      ? { githubRepositories: opts.githubRepositories }
      : {}),
    interactiveImages: opts.onOpenImage !== undefined,
    sessionLinks: true,
    tableInteractions: "enabled",
    linkFavicons: Boolean(opts.fetchLinkFavicon) && !opts.isStreaming,
  };

  // Classify completed bare JSON before Markdown can interpret its literal values.
  const jsonResult = markdown && !opts.isStreaming ? parseMarkdownJson(markdown) : null;

  const onlyPreviewChips =
    normalizedRole === "user" &&
    !markdown &&
    !normalizedMessage.replyTarget &&
    !hasImages &&
    !hasToolCards &&
    omittedMedia.length === 0 &&
    expiredPairingQrCount === 0 &&
    visibleAttachments.length > 0 &&
    visibleAttachments.every(
      (item) => isSentCommentAttachment(item) || isSentPastedTextAttachment(item),
    );
  const transparentShell =
    hasImages ||
    videoPreviews.length > 0 ||
    hasUserFiles ||
    (normalizedRole === "user" &&
      cardAttachments.some(
        (item) => isSentCommentAttachment(item) || isSentPastedTextAttachment(item),
      ));
  const bubbleClasses = [
    "chat-bubble",
    transparentShell ? "chat-bubble--with-images" : "",
    onlyPreviewChips ? "chat-bubble--preview-chips-only" : "",
    hasUserFiles ? "chat-bubble--with-files" : "",
    isToolShell ? "chat-bubble--tool-shell" : "",
    opts.isStreaming ? "streaming" : "",
  ]
    .filter(Boolean)
    .join(" ");

  // Suppress bubbles with no visible content, including relocated tool cards.
  if (
    !markdown &&
    !asyncQuestions &&
    !reasoningMarkdown &&
    !hasToolCards &&
    !hasImages &&
    expiredPairingQrCount === 0 &&
    omittedMedia.length === 0 &&
    visibleAttachments.length === 0 &&
    assistantViewBlocks.length === 0 &&
    clawHubCards.length === 0 &&
    !normalizedMessage.replyTarget
  ) {
    return nothing;
  }

  const toolMessageDisclosureId = `toolmsg:${messageKey}`;
  const toolMessageExpanded = opts.isToolMessageExpanded?.(toolMessageDisclosureId) ?? false;
  const toolNames = [...new Set(toolCards.map((c) => c.name))];
  const singleToolCard = toolCards.length === 1 ? toolCards[0] : null;
  const standaloneToolPayload =
    isStandaloneToolMessage &&
    Boolean(markdown) &&
    !jsonResult &&
    !hasImages &&
    singleToolCard?.outputText?.trim() === markdown?.trim();
  const bodyMarkdown = standaloneToolPayload ? null : markdown;
  const renderInOrder =
    normalizedRole === "assistant" &&
    Boolean(markdown) &&
    !asyncQuestions &&
    (!disclosure?.expanded || Boolean(disclosure.message)) &&
    orderedContent.some((item) => item.type !== "text");
  // One expanded card already closes with its own outcome line; every other
  // shape renders inline rows only, so the message body records the failure.
  const expandsSingleToolCard =
    Boolean(singleToolCard) && (!markdown || standaloneToolPayload) && !hasImages;
  const failedToolCard = expandsSingleToolCard ? undefined : toolCards.find(isToolCardError);
  const singleToolDisplay = singleToolCard
    ? resolveToolDisplay({
        name: singleToolCard.name,
        args: singleToolCard.args,
        detailMode: "explain",
      })
    : null;
  const singleToolDisplayDetail =
    singleToolCard && singleToolDisplay
      ? resolveCollapsedToolDetail(singleToolCard, singleToolDisplay.detail)
      : undefined;
  const toolSummaryLabelRaw = singleToolDisplayDetail
    ? !markdown && !hasImages
      ? singleToolDisplayDetail
      : singleToolCard?.outputText?.trim()
        ? "output"
        : undefined
    : toolNames.length <= 3
      ? toolNames.join(", ")
      : `${toolNames.slice(0, 2).join(", ")} +${toolNames.length - 2} more`;
  const toolPreview = markdown ? (formatCollapsedToolPreviewText(markdown) ?? "") : "";
  const toolMessageLabelRaw =
    singleToolDisplay && !markdown && !hasImages
      ? singleToolDisplay.label
      : t("chat.toolCards.toolOutput");
  const toolMessageLabel =
    formatCollapsedToolSummaryText(toolMessageLabelRaw) ?? toolMessageLabelRaw;
  const toolSummaryLabel = formatDistinctCollapsedToolSummaryText(
    toolSummaryLabelRaw,
    toolMessageLabel,
  );
  const toolMessageIcon = singleToolDisplay
    ? renderToolIcon(singleToolDisplay.icon, {
        toolName: singleToolDisplay.name,
        pluginToolIcons: opts.pluginToolIcons,
      })
    : icons.zap;
  const assistantViewContent =
    sourceRole === "assistant" && assistantViewBlocks.length > 0
      ? html`${assistantViewBlocks.map(
          (block) => html`<div class="chat-tool-card__widget-host">
            ${renderToolPreview(block.preview, "chat_message", {
              rawText: block.rawText ?? null,
              canvasPluginSurfaceUrl: opts.canvasPluginSurfaceUrl,
              boardProvider: opts.boardProvider,
              embedSandboxMode: opts.embedSandboxMode ?? "scripts",
              allowExternalEmbedUrls: opts.allowExternalEmbedUrls,
              sessionKey: opts.sessionKey,
              messageTimestamp: typeof m.timestamp === "number" ? m.timestamp : undefined,
            })}
            ${
              block.rawText
                ? html`<div class="chat-tool-card__widget-raw">
                    ${renderRawOutputToggle(block.rawText)}
                  </div>`
                : nothing
            }
          </div>`,
        )}`
      : nothing;

  const duplicateCount = Math.max(1, Math.floor(opts.duplicateCount ?? 1));
  const duplicateSuffix =
    duplicateCount > 1
      ? {
          count: duplicateCount,
          label: t("chat.messages.duplicatesCollapsed", { count: String(duplicateCount) }),
        }
      : undefined;

  // Pure tool messages (no text/images/attachments) skip the "Tool output"
  // shell and render as flat kind-aware rows, one disclosure level deep.
  const onlyToolCards =
    isStandaloneToolMessage &&
    hasToolCards &&
    !markdown &&
    !hasImages &&
    expiredPairingQrCount === 0 &&
    omittedMedia.length === 0 &&
    visibleAttachments.length === 0 &&
    assistantViewBlocks.length === 0 &&
    !reasoningMarkdown;

  const toolRenderOptions = { ...opts, messageKey, onOpenSidebar };
  const renderText = () =>
    asyncQuestions
      ? renderAsyncQuestionSummary(asyncQuestions, opts.asyncQuestions!)
      : jsonResult
        ? renderMessageJson(
            jsonResult,
            messageKey,
            { ...opts, role: isStandaloneToolMessage ? "tool" : normalizedRole },
            markdownRenderOptions,
          )
        : bodyMarkdown
          ? renderMessageMarkdown(
              bodyMarkdown,
              messageKey,
              { ...opts, role: isStandaloneToolMessage ? "tool" : normalizedRole },
              markdownRenderOptions,
              duplicateSuffix,
            )
          : nothing;
  const renderOrderedContent = () => {
    const prepared = prepareMarkdownMedia(orderedContent, (item) => {
      if (item.type === "image") {
        return renderMessageImages([item.image], imageRenderOptions);
      }
      return renderAssistantAttachments(
        [item],
        imageRenderOptions,
        onOpenSidebar,
        opts.onAssistantAttachmentLoaded,
      );
    });
    const text = resolveMessageDisplayMarkdown(message, {
      ...normalizedMessage,
      content: [{ type: "text", text: prepared.markdown }],
    });
    return renderMessageMarkdown(
      text,
      messageKey,
      {
        ...opts,
        role: normalizedRole,
        assistantMessageDisclosure: disclosure ? { ...disclosure, markdown: text } : undefined,
      },
      markdownRenderOptions,
      markdown ? duplicateSuffix : undefined,
      { ...prepared.media, text: bodyMarkdown ?? "" },
    );
  };
  const renderMessageContent = () => (renderInOrder ? renderOrderedContent() : renderText());
  // Collapsed tool results must not load attachments or render hidden markdown.
  // Retained panes use opacity, so hidden transcripts must unmount video previews.
  const renderBody = () => html`
    ${
      sourceRole === "assistant"
        ? clawHubCards.map(
            (card) => html`<openclaw-chat-clawhub-card
              .recommendation=${card}
              .agentId=${opts.agentId}
            ></openclaw-chat-clawhub-card>`,
          )
        : nothing
    }
    ${renderPairingQrExpiryNotices(expiredPairingQrCount)}
    ${renderMessageImages(
      renderInOrder ? supplementalImages : images,
      imageRenderOptions,
      videoPreviews.map(
        (item) => html`
          <div class="chat-image-frame chat-video-preview">
            ${opts.transcriptVisible === false ? nothing : renderMessageAttachment(item, imageRenderOptions, onOpenSidebar, opts.onAssistantAttachmentLoaded, "preview")}
          </div>
        `,
      ),
    )}
    ${renderOmittedMedia(omittedMedia)}
    ${renderAssistantAttachments(
      renderInOrder ? supplementalAttachments : cardAttachments,
      imageRenderOptions,
      onOpenSidebar,
      opts.onAssistantAttachmentLoaded,
      normalizedRole === "assistant",
    )}
    ${isStandaloneToolMessage ? assistantViewContent : nothing}
    ${
      reasoningMarkdown
        ? html`<div class="chat-thinking">
            ${unsafeHTML(
              toSanitizedMarkdownHtml(reasoningMarkdown, {
                codeBlockInteraction: "interactive",
              }),
            )}
          </div>`
        : nothing
    }
    ${isStandaloneToolMessage ? nothing : assistantViewContent}
    ${
      opts.avatar
        ? html`<div class="chat-message-avatar-anchor">
            ${renderMessageContent()}${opts.avatar}
          </div>`
        : renderMessageContent()
    }
    ${
      hasToolCards
        ? isStandaloneToolMessage && expandsSingleToolCard && singleToolCard
          ? renderExpandedToolCardContent(singleToolCard, toolRenderOptions)
          : renderInlineToolCards(toolCards, {
              ...toolRenderOptions,
              showApprovalReviews: isStandaloneToolMessage ? false : undefined,
            })
        : nothing
    }
    ${
      isStandaloneToolMessage && failedToolCard
        ? renderToolOutcome("failed", failedToolCard.exitCode)
        : nothing
    }
  `;

  return html`
    <div
      class="${bubbleClasses}"
      ${opts.entryRef ? ref(opts.entryRef) : nothing}
      data-message-id=${messageKey}
      data-entry-id=${opts.entryId || nothing}
      data-message-text=${actionText || nothing}
      .messageActions=${opts.messageActions}
    >
      ${renderReplyPreview(
        normalizedMessage.replyTarget,
        normalizedMessage.replyTarget?.kind === "id"
          ? (opts.resolveReplyPreview?.(normalizedMessage.replyTarget.id) ??
              normalizedMessage.replyPreview)
          : undefined,
        opts.onOpenReply,
        opts.onResolveReply,
        normalizedMessage.replyTarget?.kind === "id" &&
          opts.replyNavigationId === normalizedMessage.replyTarget.id,
      )}
      ${
        onlyToolCards
          ? renderInlineToolCards(toolCards, toolRenderOptions)
          : isStandaloneToolMessage
            ? renderPluginToolResult(
                singleToolCard,
                { ...toolRenderOptions, expanded: toolMessageExpanded },
                html`
                  <div
                    class="chat-tool-msg-collapse chat-tool-msg-collapse--manual ${
                      toolMessageExpanded ? "is-open" : ""
                    }"
                  >
                    <button
                      class="chat-inline-disclosure chat-tool-msg-summary"
                      type="button"
                      aria-expanded=${String(toolMessageExpanded)}
                      @pointerenter=${syncToolDisclosureOverflow}
                      @focus=${syncToolDisclosureOverflow}
                      @click=${(event: MouseEvent) => {
                        if (shouldToggleSelectableDisclosure(event)) {
                          opts.onToggleToolMessageExpanded?.(
                            toolMessageDisclosureId,
                            toolMessageExpanded,
                          );
                        }
                      }}
                    >
                      <span class="chat-tool-msg-summary__icon">${toolMessageIcon}</span>
                      <span class="chat-tool-disclosure__content">
                        <span class="chat-tool-msg-summary__label">${toolMessageLabel}</span>
                        ${
                          toolSummaryLabel
                            ? html`<span class="chat-tool-msg-summary__names"
                                >${toolSummaryLabel}</span
                              >`
                            : toolPreview
                              ? html`<span class="chat-tool-msg-summary__preview"
                                  >${toolPreview}</span
                                >`
                              : nothing
                        }
                      </span>
                      <span class="chat-tool-row__chevron" aria-hidden="true"
                        >${icons.chevronRight}</span
                      >
                    </button>
                    ${
                      toolMessageExpanded
                        ? html`<div class="chat-tool-msg-body">${renderBody()}</div>`
                        : renderOmittedMedia(omittedMedia)
                    }
                    ${toolCards.map((card) => renderToolApprovalReviews(card))}
                  </div>
                `,
              )
            : renderBody()
      }
      ${
        sourceRole === "assistant" && assistantMessageIsInterrupted(message)
          ? html`<div
              class="chat-tasks-status chat-turn-recap chat-turn-recap--continuation"
              role="status"
            >
              ${t("chat.composer.runInterrupted")}
            </div>`
          : nothing
      }
      ${
        duplicateCount > 1 && (!markdown || jsonResult)
          ? html`<div
              class="chat-duplicate-count"
              aria-label=${t("chat.messages.duplicatesCollapsed", {
                count: String(duplicateCount),
              })}
            >
              ×${duplicateCount}
            </div>`
          : nothing
      }
    </div>
    ${renderMessageWorkContext(message)}
  `;
}

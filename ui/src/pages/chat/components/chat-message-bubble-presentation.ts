import { readSessionMessageIdentity } from "@openclaw/gateway-client/browser";
import { CHAT_PENDING_INPUT_MESSAGE_PREFIX } from "../../../../../packages/gateway-protocol/src/schema/chat-history-constants.js";
import { parseMarkdownJson } from "../../../components/markdown-json.ts";
import type { MarkdownRenderOptions } from "../../../components/markdown-render-options.ts";
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
import { resolveToolDisplay } from "../../../lib/chat/tool-display.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { emptyLegacyContent as litNothing } from "../../../lit/solid-content.tsx";
import { isPendingSendMessage } from "../chat-thread-items.ts";
import { workspaceResultConflictFromTranscript } from "../workspace-conflict.ts";
import { readAsyncQuestions } from "./chat-async-question.ts";
import { hasUserFileAttachments } from "./chat-message-attachments.ts";
import type { GroupedMessageOptions } from "./chat-message-bubble-options.ts";
import {
  type ChatMessageRenderPreparation,
  prepareChatMessageRender,
} from "./chat-message-markdown-view.tsx";
import { type AttachmentItem, projectMessageMedia } from "./chat-message-media.ts";
import { isSentPastedTextAttachment } from "./chat-pasted-text.ts";
import { isSentCommentAttachment } from "./chat-sent-comments.ts";
import type { SidebarContent } from "./chat-sidebar-content-types.ts";
import { resolveCollapsedToolDetail } from "./chat-tool-cards.ts";

function messageVideoSlots(
  projection: Pick<
    ReturnType<typeof projectMessageMedia>,
    "orderedContent" | "supplementalAttachments"
  >,
): AttachmentItem[] {
  return [...projection.orderedContent, ...projection.supplementalAttachments].filter(
    (item): item is AttachmentItem =>
      item.type === "attachment" && item.attachment.kind === "video",
  );
}

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

export function prepareGroupedMessage(
  preparation: ChatMessageRenderPreparation,
  messageKey: string,
  opts: GroupedMessageOptions,
  onOpenSidebar?: (content: SidebarContent) => void,
) {
  const disclosure = opts.assistantMessageDisclosure;
  const { message, normalizedMessage, displayMarkdown, humanMentions } =
    disclosure?.expanded && disclosure.message
      ? prepareChatMessageRender(disclosure.message)
      : preparation;
  // SAFETY: The group render boundary supplies transcript message records; fields remain unknown.
  const m = message as Record<string, unknown>;
  const role = typeof m.role === "string" ? m.role : "unknown";
  const sourceRole = normalizeRoleForGrouping(role);
  const asyncQuestions = opts.asyncQuestions?.submit ? readAsyncQuestions(message) : null;
  const normalizedRole = normalizeRoleForGrouping(normalizedMessage.role);
  const workspaceConflict = workspaceResultConflictFromTranscript(message);

  const isToolShell = normalizedRole === "tool";
  const isStandaloneToolMessage = isStandaloneToolMessageForDisplay(message);

  const toolCards = (opts.showToolCalls ?? true) ? extractToolCardsCached(message) : [];
  // Nested cards moved under their parent must not leave empty message shells.
  const hasToolCards = toolCards.some((card) => opts.toolCardOverrides?.get(card) !== litNothing);
  const {
    images,
    attachments: visibleAttachments,
    expiredPairingQrCount,
    nextPairingQrExpiresAt,
    orderedContent,
    supplementalImages,
    supplementalAttachments,
  } = projectMessageMedia(message, normalizedMessage.content);
  const hasImages = images.length > 0;
  const videoPreviews =
    normalizedRole === "user"
      ? visibleAttachments.filter(
          (item): item is AttachmentItem =>
            item.type === "attachment" && item.attachment.kind === "video",
        )
      : [];
  const cardAttachments = visibleAttachments.filter(
    (item) => item.type !== "attachment" || !videoPreviews.includes(item),
  );
  const hasUserFiles = normalizedRole === "user" && hasUserFileAttachments(cardAttachments);
  const imageRenderOptions = {
    galleryImages: images,
    galleryVideos: (selected: AttachmentItem) => {
      const local = messageVideoSlots({ orderedContent, supplementalAttachments });
      const slot = local.indexOf(selected);
      const turn = opts.getTurnVideoMessages?.(messageKey);
      if (!turn || slot < 0) {
        return { index: slot, items: local };
      }
      const items: AttachmentItem[] = [];
      let index = -1;
      for (const entry of turn) {
        if (entry.key === messageKey) {
          index = items.length + slot;
          items.push(...local);
        } else {
          const prepared = prepareChatMessageRender(entry.message);
          items.push(
            ...messageVideoSlots(
              projectMessageMedia(prepared.message, prepared.normalizedMessage.content),
            ),
          );
        }
      }
      return { index, items };
    },
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
  const omittedMedia = normalizedMessage.content.filter((item) => item.type === "omitted_media");
  const assistantViewBlocks = normalizedMessage.content.filter((item) => item.type === "canvas");
  const hasImagesOrNotices = hasImages || expiredPairingQrCount !== 0 || omittedMedia.length !== 0;
  const hasMediaContent =
    hasImagesOrNotices || visibleAttachments.length !== 0 || assistantViewBlocks.length !== 0;
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
    !hasImagesOrNotices &&
    !hasToolCards &&
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
  ];

  // Suppress bubbles with no visible content, including relocated tool cards.
  const empty =
    !markdown &&
    !asyncQuestions &&
    !reasoningMarkdown &&
    !hasToolCards &&
    !hasMediaContent &&
    clawHubCards.length === 0 &&
    !normalizedMessage.replyTarget;

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
    isStandaloneToolMessage && hasToolCards && !markdown && !hasMediaContent && !reasoningMarkdown;

  const toolRenderOptions = { ...opts, messageKey, onOpenSidebar };
  return {
    disclosure,
    message,
    normalizedMessage,
    m,
    sourceRole,
    asyncQuestions,
    normalizedRole,
    workspaceConflict,
    isStandaloneToolMessage,
    toolCards,
    hasToolCards,
    images,
    expiredPairingQrCount,
    nextPairingQrExpiresAt,
    orderedContent,
    supplementalImages,
    supplementalAttachments,
    videoPreviews,
    cardAttachments,
    imageRenderOptions,
    actionText,
    omittedMedia,
    assistantViewBlocks,
    clawHubCards,
    reasoningMarkdown,
    markdown,
    markdownRenderOptions,
    jsonResult,
    bubbleClasses,
    empty,
    toolMessageDisclosureId,
    toolMessageExpanded,
    singleToolCard,
    bodyMarkdown,
    renderInOrder,
    expandsSingleToolCard,
    failedToolCard,
    singleToolDisplay,
    toolSummaryLabel,
    toolMessageLabel,
    toolPreview,
    duplicateCount,
    duplicateSuffix,
    onlyToolCards,
    toolRenderOptions,
  };
}

export type GroupedMessagePresentation = ReturnType<typeof prepareGroupedMessage>;

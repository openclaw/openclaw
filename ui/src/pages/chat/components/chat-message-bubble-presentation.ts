import { readSessionMessageIdentity } from "@openclaw/gateway-client/browser";
import type { Accessor } from "solid-js";
import { CHAT_PENDING_INPUT_MESSAGE_PREFIX } from "../../../../../packages/gateway-protocol/src/schema/chat-history-constants.js";
import { parseMarkdownJson } from "../../../components/markdown-json.ts";
import type { MarkdownRenderOptions } from "../../../components/markdown-render-options.ts";
import {
  type ChatMessageRenderPreparation,
  prepareChatMessageRender,
} from "../../../lib/chat/message-display.ts";
import { extractThinkingCached } from "../../../lib/chat/message-extract.ts";
import {
  isStandaloneToolMessageForDisplay,
  normalizeRoleForGrouping,
} from "../../../lib/chat/message-normalizer.ts";
import { extractToolCardsCached, isToolCardError } from "../../../lib/chat/tool-cards.ts";
import { isProviderVoiceTranscript } from "../chat-assistant-reply.ts";
import { isPendingSendMessage } from "../chat-thread-items.ts";
import { workspaceResultConflictFromTranscript } from "../workspace-conflict.ts";
import { readAsyncQuestions } from "./chat-async-question-content.ts";
import { hasUserFileAttachments } from "./chat-message-attachments.ts";
import type { GroupedMessageOptions } from "./chat-message-bubble-options.ts";
import { type AttachmentItem, type ImageBlock, projectMessageMedia } from "./chat-message-media.ts";
import { isSentPastedTextAttachment } from "./chat-pasted-text.ts";
import { isSentCommentAttachment } from "./chat-sent-comments.ts";
import type { SidebarContent } from "./chat-sidebar-content-types.ts";

type MessageMediaProjection = Pick<
  ReturnType<typeof projectMessageMedia>,
  "images" | "orderedContent" | "supplementalImages" | "supplementalAttachments"
>;

function messageVideoSlots(
  projection: Pick<MessageMediaProjection, "orderedContent" | "supplementalAttachments">,
): AttachmentItem[] {
  return [...projection.orderedContent, ...projection.supplementalAttachments].filter(
    (item): item is AttachmentItem =>
      item.type === "attachment" && item.attachment.kind === "video",
  );
}

/** Image tiles in transcript order; in-order replies render unpositioned images first. */
function messageImageSlots(projection: MessageMediaProjection, renderInOrder: boolean) {
  return renderInOrder
    ? [
        ...projection.supplementalImages,
        ...projection.orderedContent.flatMap((item) => (item.type === "image" ? [item.image] : [])),
      ]
    : projection.images;
}

function rendersMediaInOrder(params: {
  role: string;
  markdown: string | null;
  asyncQuestions: boolean;
  disclosure?: GroupedMessageOptions["assistantMessageDisclosure"];
  orderedContent: MessageMediaProjection["orderedContent"];
}) {
  return (
    params.role === "assistant" &&
    Boolean(params.markdown) &&
    !params.asyncQuestions &&
    (!params.disclosure?.expanded || Boolean(params.disclosure.message)) &&
    params.orderedContent.some((item) => item.type !== "text")
  );
}

/** Mirrors prepareGroupedMessage for a message that is not mounted. */
function preparedImageSlots(
  preparation: ChatMessageRenderPreparation,
  opts: MessageMediaOptions,
  projection: MessageMediaProjection = projectMessageMedia(
    preparation.message,
    preparation.normalizedMessage.content,
  ),
) {
  return messageImageSlots(
    projection,
    rendersMediaInOrder({
      role: normalizeRoleForGrouping(preparation.normalizedMessage.role),
      markdown: preparation.displayMarkdown || null,
      asyncQuestions: Boolean(
        opts.asyncQuestions?.submit && readAsyncQuestions(preparation.message),
      ),
      orderedContent: projection.orderedContent,
    }),
  );
}

/** Spans the assistant turn when one is projected; otherwise the opened message. */
function turnMediaGallery<Slot, Item>(
  messageKey: string,
  opts: MessageMediaOptions,
  local: { slots: readonly Slot[]; messageId?: string },
  selected: Slot,
  readSibling: (preparation: ChatMessageRenderPreparation) => readonly Slot[],
  toItem: (slot: Slot, messageId: string | undefined) => Item,
) {
  const slot = local.slots.indexOf(selected);
  const turn = slot < 0 ? undefined : opts.getTurnMediaMessages?.(messageKey);
  if (!turn?.some((entry) => entry.key === messageKey)) {
    return { index: slot, items: local.slots.map((value) => toItem(value, local.messageId)) };
  }
  const items: Item[] = [];
  let index = -1;
  for (const entry of turn) {
    if (entry.key === messageKey) {
      index = items.length + slot;
      items.push(...local.slots.map((value) => toItem(value, local.messageId)));
    } else {
      const prepared = prepareChatMessageRender(entry.message);
      const messageId = readSessionMessageIdentity(prepared.message)?.id ?? undefined;
      items.push(...readSibling(prepared).map((value) => toItem(value, messageId)));
    }
  }
  return { index, items };
}

function messageMediaIdentity(message: unknown, sessionKey: string | undefined) {
  const identity = readSessionMessageIdentity(message);
  if (identity?.role !== "user" || identity.isImported) {
    return { localSubmission: false };
  }
  const messageSendId = identity.sendId ?? undefined;
  if (!identity.id || isPendingSendMessage(message)) {
    return { localSubmission: Boolean(messageSendId), messageSendId };
  }
  return identity.id.startsWith(CHAT_PENDING_INPUT_MESSAGE_PREFIX)
    ? { messageSendId }
    : {
        canonicalMessageKey: JSON.stringify([sessionKey, identity.id, identity.sequence]),
        messageSendId,
      };
}

export type MessageMediaOptions = Pick<
  GroupedMessageOptions,
  | "sessionKey"
  | "agentId"
  | "mediaPolicyKey"
  | "connectionEpoch"
  | "resourceBasePath"
  | "assistantAttachmentAuthToken"
  | "mediaOwner"
  | "mediaReadAllowed"
  | "onRequestOpenImage"
  | "onOpenImage"
  | "onFindWorkspaceFile"
  | "resolveArtifactDownload"
  | "getTurnMediaMessages"
  | "asyncQuestions"
>;

/** Shared by transcript bubbles and read-only attachment catalogs. */
export function createMessageMediaOptions(
  message: unknown,
  messageKey: string,
  opts: MessageMediaOptions,
  projection: MessageMediaProjection,
  /** The mounted bubble's layout; catalogs derive it like an unmounted sibling. */
  renderInOrder?: boolean,
) {
  const messageId = readSessionMessageIdentity(message)?.id ?? undefined;
  return {
    // Galleries read membership on open; layout and sibling projection stay off the render path.
    galleryImages: (selected: ImageBlock) =>
      turnMediaGallery(
        messageKey,
        opts,
        {
          slots:
            renderInOrder === undefined
              ? preparedImageSlots(prepareChatMessageRender(message), opts, projection)
              : messageImageSlots(projection, renderInOrder),
          messageId,
        },
        selected,
        (prepared) => preparedImageSlots(prepared, opts),
        (image, id) => ({ image, messageId: id }),
      ),
    galleryVideos: (selected: AttachmentItem) =>
      turnMediaGallery(
        messageKey,
        opts,
        { slots: messageVideoSlots(projection), messageId },
        selected,
        (prepared) =>
          messageVideoSlots(
            projectMessageMedia(prepared.message, prepared.normalizedMessage.content),
          ),
        ({ type, attachment }, id) => ({ type, attachment, messageId: id }),
      ),
    sessionKey: opts.sessionKey,
    messageId,
    agentId: opts.agentId,
    policyKey: opts.mediaPolicyKey,
    ...messageMediaIdentity(message, opts.sessionKey),
    connectionEpoch: opts.connectionEpoch,
    resourceBasePath: opts.resourceBasePath,
    authToken: opts.assistantAttachmentAuthToken,
    mediaOwner: opts.mediaOwner,
    mediaReadAllowed: opts.mediaReadAllowed,
    onRequestOpenImage: opts.onRequestOpenImage,
    onOpenImage: opts.onOpenImage,
    onFindWorkspaceFile: opts.onFindWorkspaceFile,
    resolveArtifactDownload: opts.resolveArtifactDownload,
  };
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

  const voiceTranscript = isProviderVoiceTranscript(message);
  const isToolShell = normalizedRole === "tool";
  const isStandaloneToolMessage = isStandaloneToolMessageForDisplay(message);

  const toolCards = (opts.showToolCalls ?? true) ? extractToolCardsCached(message) : [];
  // Nested cards moved under their parent must not leave empty message shells.
  const hasToolCards = toolCards.some((card) => opts.toolCardOverrides?.get(card) !== null);
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
  const actionText = opts.messageActions?.markdown ?? displayMarkdown;
  const omittedMedia = normalizedMessage.content.filter((item) => item.type === "omitted_media");
  const assistantViewBlocks = normalizedMessage.content.filter((item) => item.type === "canvas");
  const inlineViewBlocks = normalizedMessage.content.filter((item) => item.type === "plugin_view");
  const hasImagesOrNotices = hasImages || expiredPairingQrCount !== 0 || omittedMedia.length !== 0;
  const hasMediaContent =
    hasImagesOrNotices ||
    visibleAttachments.length !== 0 ||
    assistantViewBlocks.length !== 0 ||
    inlineViewBlocks.length !== 0;
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
    humanMentions: markdown === displayMarkdown ? humanMentions : undefined,
    interactiveImages: opts.onOpenImage !== undefined,
    sessionLinks: true,
    tableInteractions: "enabled",
    linkFavicons: Boolean(opts.fetchLinkFavicon) && !opts.isStreaming,
  };

  // Classify completed bare JSON before Markdown can interpret its literal values.
  const jsonResult = markdown && !opts.isStreaming ? parseMarkdownJson(markdown) : null;

  const inlineComments =
    normalizedRole === "user" &&
    !markdown &&
    !normalizedMessage.replyTarget &&
    !hasImagesOrNotices &&
    !hasToolCards &&
    !asyncQuestions &&
    visibleAttachments.length > 0 &&
    visibleAttachments.every(isSentCommentAttachment);
  const onlyPreviewChips =
    !inlineComments &&
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
      !inlineComments &&
      cardAttachments.some(
        (item) => isSentCommentAttachment(item) || isSentPastedTextAttachment(item),
      ));
  const bubbleClasses = [
    voiceTranscript ? "chat-voice-transcript" : "chat-bubble",
    opts.firstBubbleKey === messageKey ? "chat-bubble--first" : "",
    transparentShell ? "chat-bubble--with-images" : "",
    onlyPreviewChips ? "chat-bubble--preview-chips-only" : "",
    hasUserFiles ? "chat-bubble--with-files" : "",
    isToolShell ? "chat-bubble--tool-shell" : "",
    reasoningMarkdown && !markdown && !hasMediaContent && !hasToolCards && !asyncQuestions
      ? "chat-bubble--activity-only"
      : "",
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
  const singleToolCard = toolCards.length === 1 ? toolCards[0] : null;
  const standaloneToolPayload =
    isStandaloneToolMessage &&
    Boolean(markdown) &&
    !jsonResult &&
    !hasImages &&
    singleToolCard?.outputText?.trim() === markdown?.trim();
  const bodyMarkdown = standaloneToolPayload ? null : markdown;
  const renderInOrder = rendersMediaInOrder({
    role: normalizedRole,
    markdown,
    asyncQuestions: Boolean(asyncQuestions),
    disclosure,
    orderedContent,
  });
  const imageRenderOptions = createMessageMediaOptions(
    message,
    messageKey,
    opts,
    { images, orderedContent, supplementalImages, supplementalAttachments },
    renderInOrder,
  );
  // One expanded card already closes with its own outcome line; every other
  // shape renders inline rows only, so the message body records the failure.
  const expandsSingleToolCard =
    Boolean(singleToolCard) && (!markdown || standaloneToolPayload) && !hasImages;
  const failedToolCard = expandsSingleToolCard ? undefined : toolCards.find(isToolCardError);

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
    voiceTranscript,
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
    inlineComments,
    imageRenderOptions,
    actionText,
    omittedMedia,
    assistantViewBlocks,
    inlineViewBlocks,
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
    onlyToolCards,
    toolRenderOptions,
  };
}

export type GroupedMessagePresentation = ReturnType<typeof prepareGroupedMessage>;

export type MessageContentProps = {
  state: Accessor<GroupedMessagePresentation>;
  messageKey: string;
  options: GroupedMessageOptions;
  onOpenSidebar?: (content: SidebarContent) => void;
};

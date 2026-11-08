import { mediaKindFromMime } from "@openclaw/media-core/constants";
import {
  asFiniteNumber,
  asNonNegativeFiniteNumber,
} from "@openclaw/normalization-core/number-coercion";
import { asOptionalRecord, readStringField } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { parseAgentSessionKeyParts } from "@openclaw/session-url-contract";
import { stripInboundMetadata } from "../../../../src/auto-reply/reply/strip-inbound-meta.js";
import { stripUserEnvelopeForDisplay } from "../../../../src/auto-reply/reply/user-envelope-display.js";
import {
  extractCanvasShortcodes,
  isCanvasBoardWidgetName,
} from "../../../../src/chat/canvas-render.js";
import { readMessageClientSources } from "../../../../src/chat/message-client-source.js";
import { projectImportedMessageForDisplay } from "../../../../src/chat/session-catalog-display.js";
import {
  isToolCallContentType,
  isToolResultContentType,
  resolveToolBlockArgs,
} from "../../../../src/chat/tool-content.js";
import { projectChatWorkContextForDisplay } from "../../../../src/chat/work-context.js";
import { splitMediaFromOutput } from "../../../../src/media/parse.js";
import { readClawHubRecommendation } from "../../../../src/shared/clawhub-recommendations.js";
import { readPluginInlineViewBlock } from "../../../../src/shared/plugin-inline-view.js";
import { getMediaFileExtension, labelForMediaPath } from "../media-file-extension.ts";
import { stripThinkingTags } from "../strip-thinking-tags.ts";
import type { NormalizedMessage, MessageContentItem, MessageImageSource } from "./chat-types.ts";
import { getMessageDerivations, readMessageDerivations } from "./message-derivations.ts";
import { normalizeAttachmentContentBlock } from "./message-normalizer-attachments.ts";
import {
  resolveMessageSender,
  resolveMessageSenderLabel,
  type SenderIdentity,
} from "./sender-label.ts";

function imageDataUrl(data: unknown, mimeType: unknown): string | undefined {
  return typeof data === "string"
    ? data.startsWith("data:")
      ? data
      : `data:${typeof mimeType === "string" ? mimeType : "image/png"};base64,${data}`
    : undefined;
}

function normalizeImageContentBlock(
  item: Record<string, unknown>,
): Extract<MessageContentItem, { type: "image" }> | undefined {
  const source = asOptionalRecord(item.source);
  if (item.type === "image") {
    const base64Source = source?.type === "base64" && typeof source.data === "string";
    const image: MessageImageSource = {
      url: normalizeOptionalString(item.url) ?? normalizeOptionalString(source?.url),
      dataUrl: imageDataUrl(
        base64Source ? source.data : item.data,
        base64Source ? source.media_type : item.mimeType,
      ),
      preferData: true,
      mimeType: readStringField(item, "mimeType") ?? readStringField(source, "media_type"),
    };
    for (const key of ["artifactId", "fileName", "openUrl", "alt"] as const) {
      const value = readStringField(item, key);
      if (value !== undefined) {
        image[key] = value;
      }
    }
    for (const key of ["sizeBytes", "width", "height"] as const) {
      const value = asFiniteNumber(item[key]);
      if (value !== undefined) {
        image[key] = value;
      }
    }
    return { type: "image", sources: [image], inlineSlot: true };
  }
  if (item.type === "image_url") {
    return {
      type: "image",
      sources: [{ url: normalizeOptionalString(asOptionalRecord(item.image_url)?.url) }],
    };
  }
  if (item.type === "input_image") {
    return {
      type: "image",
      sources: [
        {
          url:
            normalizeOptionalString(item.image_url) ??
            normalizeOptionalString(asOptionalRecord(item.image_url)?.url),
        },
        {
          url: normalizeOptionalString(source?.url),
          dataUrl: imageDataUrl(source?.data, source?.media_type),
          mimeType: readStringField(source, "media_type"),
        },
      ],
    };
  }
  if (item.type === "openclaw_pairing_qr") {
    return {
      type: "image",
      sources: [
        {
          url: normalizeOptionalString(item.image_url),
          alt: readStringField(item, "alt"),
        },
      ],
      expiresAtMs: asFiniteNumber(item.expiresAtMs),
    };
  }
  return undefined;
}

type CanvasPreview = Extract<MessageContentItem, { type: "canvas" }>["preview"];

export type NormalizedMessageFacts = Omit<NormalizedMessage, "content"> & {
  hasContent: boolean;
  hasText: boolean;
  hasDisplayText: boolean;
  hasNonTextContent: boolean;
  canvasPreviews: CanvasPreview[];
  estimatedContentSize: number;
};
type MessageDelivery = { audioAsVoice?: true; replyToCurrent?: true; replyToId?: string };

export function canvasPreviewsMatch(
  first: Pick<CanvasPreview, "viewId" | "url">,
  second: Pick<CanvasPreview, "viewId" | "url">,
): boolean {
  return Boolean(
    (first.viewId && first.viewId === second.viewId) || (first.url && first.url === second.url),
  );
}

function readMessageDelivery(value: unknown): MessageDelivery | undefined {
  const delivery = asOptionalRecord(value);
  if (
    !delivery ||
    (delivery.audioAsVoice !== undefined && delivery.audioAsVoice !== true) ||
    (delivery.replyToCurrent !== undefined && delivery.replyToCurrent !== true)
  ) {
    return undefined;
  }
  return {
    audioAsVoice: delivery.audioAsVoice,
    replyToCurrent: delivery.replyToCurrent,
    replyToId: readStringField(delivery, "replyToId"),
  };
}

// Session creation records its agent-written opening as inter-session
// provenance; the transcript sender stays an opaque id without an identity.
/** Identifies the agent that wrote a session's opening message. */
function resolveAgentOpeningSender(message: Record<string, unknown>): SenderIdentity | null {
  const provenance = asOptionalRecord(message.provenance);
  const sourceTool = provenance?.sourceTool;
  if (
    message.role !== "user" ||
    provenance?.kind !== "inter_session" ||
    (sourceTool !== "sessions_create" && sourceTool !== "sessions_spawn")
  ) {
    return null;
  }
  const agentId = parseAgentSessionKeyParts(
    readStringField(provenance, "sourceSessionKey") ?? "",
  )?.agentId;
  return agentId ? { identity: { type: "agent", id: agentId } } : null;
}

export function readMessageSenderSession(value: unknown): NormalizedMessage["senderSession"] {
  const source = asOptionalRecord(value);
  if (!source) {
    return undefined;
  }
  const sessionKey = normalizeOptionalString(source.sessionKey);
  const agentId = normalizeOptionalString(source.agentId);
  const label = normalizeOptionalString(source.label);
  return sessionKey || agentId
    ? {
        ...("sessionKey" in source ? { sessionKey } : {}),
        ...("agentId" in source ? { agentId } : {}),
        ...(label ? { label } : {}),
      }
    : undefined;
}

export function normalizeRoleForGrouping(role: string): string {
  const lower = role.toLowerCase();
  if (["user", "assistant", "system"].includes(lower)) {
    return lower;
  }
  if (["toolresult", "tool_result", "tool", "function"].includes(lower)) {
    return "tool";
  }
  return role;
}

function hasToolMessageEnvelope(message: Record<string, unknown> | undefined): boolean {
  return (
    typeof message?.toolCallId === "string" ||
    typeof message?.tool_call_id === "string" ||
    typeof message?.toolUseId === "string" ||
    typeof message?.tool_use_id === "string" ||
    typeof message?.toolName === "string" ||
    typeof message?.tool_name === "string"
  );
}

export function resolveMessageRole(message: unknown): string {
  const m = asOptionalRecord(message);
  const content = m?.content;
  const hasToolContent =
    Array.isArray(content) &&
    content.some((value) => {
      const type = asOptionalRecord(value)?.type;
      return isToolResultContentType(type) || isToolCallContentType(type);
    });
  return hasToolContent || hasToolMessageEnvelope(m)
    ? "toolResult"
    : (readStringField(m, "role") ?? "unknown");
}

export function isToolResultMessage(message: unknown): boolean {
  return isToolResultContentType(asOptionalRecord(message)?.role);
}

export function isStandaloneToolMessageForDisplay(message: unknown): boolean {
  // Tool classification needs envelope fields, not parsed content or media.
  const m = asOptionalRecord(message);
  const role = typeof m?.role === "string" ? normalizeRoleForGrouping(m.role) : "unknown";
  return role === "tool" || hasToolMessageEnvelope(m);
}

export function readCanvasContentPreview(content: unknown): CanvasPreview | null {
  const item = asOptionalRecord(content);
  const preview = item?.type === "canvas" ? asOptionalRecord(item.preview) : undefined;
  if (
    !preview ||
    preview.kind !== "canvas" ||
    preview.surface === "tool_card" ||
    preview.render !== "url"
  ) {
    return null;
  }
  const result: CanvasPreview = { kind: "canvas", surface: "assistant_message", render: "url" };
  for (const key of ["title", "url", "viewId", "className", "style"] as const) {
    const value = readStringField(preview, key);
    if (value !== undefined) {
      result[key] = value;
    }
  }
  const preferredHeight = asFiniteNumber(preview.preferredHeight);
  if (preferredHeight !== undefined) {
    result.preferredHeight = preferredHeight;
  }
  const sandbox = preview.sandbox;
  if (sandbox === "strict" || sandbox === "scripts") {
    result.sandbox = sandbox;
  }
  const boardWidgetName = preview.boardWidgetName;
  if (isCanvasBoardWidgetName(boardWidgetName)) {
    result.boardWidgetName = boardWidgetName;
  }
  const mcpApp = asOptionalRecord(preview.mcpApp);
  const viewId = readStringField(mcpApp, "viewId");
  if (viewId?.trim()) {
    result.mcpApp = { viewId };
    for (const key of [
      "serverName",
      "toolName",
      "uiResourceUri",
      "toolCallId",
      "originSessionKey",
    ] as const) {
      const value = readStringField(mcpApp, key);
      if (value !== undefined) {
        result.mcpApp[key] = value;
      }
    }
  }
  return result;
}

const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  heic: "image/heic",
  heif: "image/heif",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  flac: "audio/flac",
  aac: "audio/aac",
  opus: "audio/opus",
  m4a: "audio/mp4",
  m2a: "audio/mpeg",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  zip: "application/zip",
};

function coerceMediaContentBlock(
  item: Record<string, unknown>,
): Extract<MessageContentItem, { type: "attachment" }> | null {
  const kind = item.type;
  const managedUrl = readStringField(item, "url")?.trim();
  if (kind !== "audio" && kind !== "video") {
    return null;
  }
  let url = managedUrl;
  let mimeType = managedUrl ? readStringField(item, "mimeType") : undefined;
  if (!url) {
    const source = kind === "audio" ? asOptionalRecord(item.source) : undefined;
    if (!source) {
      return null;
    }
    const rawMediaType = readStringField(source, "media_type")?.trim();
    mimeType = rawMediaType?.toLowerCase().startsWith("audio/") ? rawMediaType : "audio/mpeg";
    const type = source.type;
    const data = readStringField(source, type === "base64" ? "data" : "url")?.trim();
    if (!data || (type !== "base64" && type !== "url")) {
      return null;
    }
    url = type === "base64" && !data.startsWith("data:") ? `data:${mimeType};base64,${data}` : data;
  }
  const attachment: Extract<MessageContentItem, { type: "attachment" }>["attachment"] = {
    url,
    kind,
    label:
      (managedUrl ? readStringField(item, "fileName")?.trim() : undefined) ||
      readStringField(item, "label")?.trim() ||
      (kind === "audio" ? "Audio" : "Video"),
    ...(mimeType !== undefined ? { mimeType } : {}),
  };
  const artifactId = managedUrl ? readStringField(item, "artifactId") : undefined;
  if (artifactId !== undefined) {
    attachment.artifactId = artifactId;
  }
  if (kind === "audio" && item.isVoiceNote === true) {
    attachment.isVoiceNote = true;
  }
  if (managedUrl) {
    const playback = item.playback;
    if (playback === "native" || playback === "transcode") {
      attachment.playback = playback;
    }
    for (const key of ["sizeBytes", "durationMs", "width", "height"] as const) {
      const value = asFiniteNumber(item[key]);
      const dimension = key === "width" || key === "height";
      if (value !== undefined && (dimension ? kind === "video" && value > 0 : value >= 0)) {
        attachment[key] = value;
      }
    }
  }
  return { type: "attachment", attachment };
}

function resolveDeliveryReplyTarget(
  delivery: MessageDelivery | undefined,
): NormalizedMessage["replyTarget"] {
  const replyToId = delivery?.replyToId?.trim();
  return replyToId
    ? { kind: "id", id: replyToId }
    : delivery?.replyToCurrent === true
      ? { kind: "current" }
      : null;
}

function normalizeMessageContent(
  message: unknown,
  receiveContent: (item: MessageContentItem) => void,
): { metadata: Omit<NormalizedMessage, "content">; cacheable: boolean } {
  const m =
    asOptionalRecord(projectChatWorkContextForDisplay(projectImportedMessageForDisplay(message))) ??
    {};
  const role = resolveMessageRole(m);
  const contentRaw =
    typeof m.content === "string" || Array.isArray(m.content)
      ? m.content
      : typeof m.text === "string"
        ? m.text
        : undefined;
  const contentItems = Array.isArray(contentRaw) ? contentRaw : null;
  const isAssistantMessage = role === "assistant";
  const delivery = isAssistantMessage ? readMessageDelivery(m.openclawDelivery) : undefined;
  // History's structured blocks retain sandbox and dashboard metadata that
  // an assistant shortcode cannot carry. Keep that representation when both exist.
  const projectedCanvasPreviews = (contentItems ?? []).flatMap((value) => {
    const preview = readCanvasContentPreview(value);
    return preview ? [preview] : [];
  });

  let audioAsVoice = false;
  let replyTarget = resolveDeliveryReplyTarget(delivery);
  const emit = (item: MessageContentItem) => {
    if (item.type !== "text") {
      receiveContent(item);
      return;
    }
    const text =
      typeof item.text === "string"
        ? role.toLowerCase() === "user"
          ? stripUserEnvelopeForDisplay(item.text)
          : stripInboundMetadata(item.text)
        : undefined;
    if (text?.trim()) {
      receiveContent({ ...item, text });
    }
  };
  const normalizeText = (text: string, block = false) => {
    if (!isAssistantMessage || asOptionalRecord(m["__openclaw"])?.catalogSource === true) {
      emit({ type: "text", text, ...(block ? { name: undefined, args: undefined } : {}) });
      return;
    }
    audioAsVoice = delivery?.audioAsVoice === true;
    const extracted = extractCanvasShortcodes(text);
    const parsed = splitMediaFromOutput(extracted.text, { extractAudioDirectives: false });
    const segments = parsed.segments ?? [{ type: "text" as const, text: parsed.text }];
    let adjacentText: string | undefined;
    let hasExpandedContent = false;
    const flushText = () => {
      // Merge before stripping: an envelope or internal tag can span segments.
      if (adjacentText?.trim()) {
        hasExpandedContent = true;
        emit({ type: "text", text: adjacentText });
      }
      adjacentText = undefined;
    };

    for (const segment of segments) {
      if (segment.type === "media") {
        flushText();
        const url = segment.url;
        const ext = getMediaFileExtension(url);
        const mimeType = ext ? MIME_BY_EXT[ext] : undefined;
        const inferredKind = mediaKindFromMime(mimeType);
        const kind =
          !inferredKind || inferredKind === "sticker" || inferredKind === "unknown"
            ? "document"
            : inferredKind;
        hasExpandedContent = true;
        emit({
          type: "attachment",
          attachment: {
            url: segment.url,
            kind,
            mimeType,
            label: labelForMediaPath(url),
            ...(kind === "audio" && audioAsVoice ? { isVoiceNote: true } : {}),
          },
        });
      } else if (segment.text) {
        adjacentText =
          adjacentText === undefined ? segment.text : `${adjacentText}\n${segment.text}`;
      }
    }
    for (const preview of extracted.previews) {
      if (
        preview.surface !== "assistant_message" ||
        projectedCanvasPreviews.some((projected) => canvasPreviewsMatch(preview, projected))
      ) {
        continue;
      }
      flushText();
      hasExpandedContent = true;
      emit({
        type: "canvas",
        preview: { ...preview, surface: "assistant_message" },
        rawText: null,
      });
    }
    flushText();
    if (!hasExpandedContent && replyTarget === null && !audioAsVoice && parsed.text.trim()) {
      emit({ type: "text", text: parsed.text });
    }
  };

  const normalizeContentItem = (value: unknown) => {
    const item = asOptionalRecord(value);
    if (!item) {
      return;
    }
    if (
      item.type === "image" &&
      item.omitted === true &&
      normalizeOptionalString(item.artifactId) === undefined &&
      normalizeOptionalString(item.url) === undefined
    ) {
      const sizeBytes = asNonNegativeFiniteNumber(item.bytes);
      emit({
        type: "omitted_media",
        media: { kind: "image", ...(sizeBytes !== undefined ? { sizeBytes } : {}) },
      });
      return;
    }
    const image = normalizeImageContentBlock(item);
    if (image) {
      emit(image);
      return;
    }
    const type = item.type;
    if (type === "plugin_view") {
      const inline = isAssistantMessage ? readPluginInlineViewBlock(item) : undefined;
      if (inline) {
        emit(inline);
      }
      return;
    }
    if (type === "clawhub") {
      const recommendation = isAssistantMessage ? readClawHubRecommendation(item) : null;
      if (recommendation) {
        emit(recommendation);
      }
      return;
    }
    const text = readStringField(item, "text");
    if (type === "thinking") {
      const thinking = readStringField(item, "thinking");
      if (thinking !== undefined) {
        emit({ type, thinking });
      }
      return;
    }
    if (isAssistantMessage) {
      const attachment = coerceMediaContentBlock(item);
      if (attachment) {
        emit(attachment);
        return;
      }
    } else if (type === "audio") {
      return;
    }
    if (type === "attachment" || type === "attachment_error") {
      for (const attachment of normalizeAttachmentContentBlock(item) ?? []) {
        emit(attachment);
      }
      return;
    }
    if (type === "canvas") {
      const preview = readCanvasContentPreview(item);
      if (preview) {
        emit({ type: "canvas", preview, rawText: readStringField(item, "rawText") ?? null });
      }
      return;
    }
    if (
      text !== undefined &&
      (type === "text" ||
        (type === "input_text" && (role === "user" || isAssistantMessage)) ||
        (type === "output_text" && isAssistantMessage))
    ) {
      if (!isAssistantMessage || item.openclawFallback !== true) {
        normalizeText(text, true);
      }
      return;
    }
    emit({
      type:
        (type as Extract<
          MessageContentItem,
          { type: "text" | "tool_call" | "tool_result" }
        >["type"]) || "text",
      text,
      name: item.name as string | undefined,
      args: resolveToolBlockArgs(item),
    });
  };

  if (typeof contentRaw === "string") {
    normalizeText(contentRaw);
  } else if (contentItems) {
    for (const item of contentItems) {
      normalizeContentItem(item);
    }
  }

  const sourceTimestamp = asFiniteNumber(m.timestamp);
  const timestamp = sourceTimestamp ?? Date.now();
  const id = readStringField(m, "id");
  const openClawMeta = asOptionalRecord(m["__openclaw"]);
  const structuredReplyToId = readStringField(openClawMeta, "replyToId")?.trim() ?? "";
  if (structuredReplyToId) {
    replyTarget = { kind: "id", id: structuredReplyToId };
  }
  const replyPreviewRecord = asOptionalRecord(openClawMeta?.replyToPreview);
  const replyPreviewText = readStringField(replyPreviewRecord, "text")?.trim() ?? "";
  const replyPreviewSender = readStringField(replyPreviewRecord, "senderLabel")?.trim() ?? "";
  const metaSender = resolveAgentOpeningSender(m) ?? resolveMessageSender(openClawMeta);
  const senderLabel = resolveMessageSenderLabel(m, metaSender);
  const sender = metaSender ?? (senderLabel ? { name: senderLabel } : null);
  const sourceClients = role === "user" ? readMessageClientSources(m) : [];

  const senderSession = readMessageSenderSession(m.senderSession);

  return {
    cacheable: sourceTimestamp !== undefined,
    metadata: {
      role,
      timestamp,
      id,
      senderLabel,
      ...(senderSession ? { senderSession } : {}),
      ...(sender ? { sender } : {}),
      ...(sourceClients.length ? { sourceClients } : {}),
      ...(audioAsVoice ? { audioAsVoice: true } : {}),
      ...(replyPreviewText || replyPreviewSender
        ? {
            replyPreview: {
              text: replyPreviewText,
              ...(replyPreviewSender ? { senderLabel: replyPreviewSender } : {}),
            },
          }
        : {}),
      ...(replyTarget ? { replyTarget } : {}),
    },
  };
}

export function normalizeMessage(message: unknown): NormalizedMessage {
  const original = asOptionalRecord(message);
  const cached = original && readMessageDerivations(original)?.normalized;
  if (cached) {
    return cached;
  }
  const content: MessageContentItem[] = [];
  const { metadata, cacheable } = normalizeMessageContent(message, (item) => content.push(item));
  const normalized: NormalizedMessage = Object.assign({ role: metadata.role, content }, metadata);
  // Retained and live messages are immutable snapshots. Missing timestamps
  // still resolve against the current clock on each call.
  if (original && cacheable) {
    getMessageDerivations(original).normalized = normalized;
  }
  return normalized;
}

function estimateTextContentSize(text: string): number {
  let size = 0;
  let fenced = false;
  let blank = false;
  for (const line of text.split("\n")) {
    if (/^\s*(```|~~~)/u.test(line)) {
      fenced = !fenced;
      size += 18;
    } else if (!line.trim()) {
      if (!blank) {
        size += 16;
      }
      blank = true;
      continue;
    } else {
      size += fenced
        ? 18
        : /^\s*(#{1,6} |\|)/u.test(line)
          ? 32
          : Math.max(1, Math.ceil(line.length / 85)) * 22;
    }
    blank = false;
  }
  return size;
}

/** Whole-history presentation facts without retaining normalized content. */
export function normalizeMessageFacts(message: unknown): NormalizedMessageFacts {
  const original = asOptionalRecord(message);
  const cached = original && readMessageDerivations(original);
  if (cached?.normalizedFacts) {
    return cached.normalizedFacts;
  }
  let hasContent = false;
  let hasText = false;
  let hasNonTextContent = false;
  let displayText: string | undefined;
  let estimatedContentSize = 0;
  const canvasPreviews: CanvasPreview[] = [];
  const receiveContent = (item: MessageContentItem) => {
    hasContent = true;
    if (item.type === "text") {
      hasText = true;
      const text = item.text ?? "";
      displayText = displayText === undefined ? text : `${displayText}\n${text}`;
      if (text) {
        estimatedContentSize += estimateTextContentSize(text);
      }
    } else if (
      item.type !== "thinking" &&
      !isToolCallContentType(item.type) &&
      !isToolResultContentType(item.type)
    ) {
      hasNonTextContent = true;
      if (item.type === "image") {
        estimatedContentSize += 180;
      } else if (item.type === "canvas") {
        canvasPreviews.push(item.preview);
      }
    }
  };
  let metadata: Omit<NormalizedMessage, "content">;
  let cacheable: boolean;
  if (cached?.normalized) {
    const { content, ...normalizedMetadata } = cached.normalized;
    for (const item of content) {
      receiveContent(item);
    }
    metadata = normalizedMetadata;
    cacheable = true;
  } else {
    ({ metadata, cacheable } = normalizeMessageContent(message, receiveContent));
  }
  const displayMetadata = asOptionalRecord(original?.["__openclaw"]);
  const hasDisplayText = Boolean(
    (displayMetadata?.truncated === true && displayMetadata.reason === "oversized") ||
    (metadata.role.toLowerCase() === "assistant"
      ? stripThinkingTags(displayText ?? "")
      : displayText
    )?.trim(),
  );
  const facts: NormalizedMessageFacts = {
    ...metadata,
    hasContent,
    hasText,
    hasDisplayText,
    hasNonTextContent,
    canvasPreviews,
    estimatedContentSize,
  };
  if (original && cacheable) {
    getMessageDerivations(original).normalizedFacts = facts;
  }
  return facts;
}

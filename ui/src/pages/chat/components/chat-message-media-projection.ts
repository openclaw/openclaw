import { asNonArrayRecord } from "@openclaw/normalization-core/record-coerce";
import { t } from "../../../i18n/index.ts";
import { registerChatComposerEnglish } from "../../../i18n/locales/en-chat-composer.ts";
import { registerChatMediaEnglish } from "../../../i18n/locales/en-chat-media.ts";
import { formatBytes } from "../../../lib/agents/display.ts";
import type { MessageContentItem, MessageImageSource } from "../../../lib/chat/chat-types.ts";
import { readTranscriptMediaEntries } from "../../../lib/chat/message-extract.ts";
import { normalizeMessage } from "../../../lib/chat/message-normalizer.ts";
import {
  isAudioTranscriptMediaPath,
  isImageMediaPath,
  isSvgImageMediaPath,
  isVideoTranscriptMediaPath,
  labelForMediaPath,
} from "../../../lib/media-file-extension.ts";
import { isCrossOriginHttpSource } from "./chat-attachment-href.ts";
import type {
  AttachmentItem,
  AssistantAttachmentItem,
  ImageBlock,
  ProjectedMessageContent,
} from "./chat-message-media.ts";

registerChatComposerEnglish();

registerChatMediaEnglish();

function appendImageBlock(images: ImageBlock[], block: ImageBlock) {
  if (
    !images.some((entry) =>
      block.factIndex !== undefined
        ? entry.factIndex === block.factIndex
        : entry.factIndex === undefined &&
          entry.url === block.url &&
          entry.artifactId === block.artifactId &&
          entry.alt === block.alt,
    )
  ) {
    images.push(block);
    return true;
  }
  return false;
}

export function resolveAttachmentImageKind(
  attachment: AttachmentItem["attachment"],
): "raster" | "svg" | undefined {
  const mimeType = attachment.mimeType?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  const inferExtension = !mimeType || mimeType === "application/octet-stream";
  const image =
    attachment.kind === "image" ||
    (attachment.kind === "document" &&
      (isImageMediaPath(attachment.url, mimeType) ||
        (inferExtension && isImageMediaPath(attachment.label, undefined))));
  if (!image) {
    return undefined;
  }
  return mimeType === "image/svg+xml" ||
    (inferExtension &&
      (isSvgImageMediaPath(attachment.url, undefined) ||
        isSvgImageMediaPath(attachment.label, undefined)))
    ? "svg"
    : "raster";
}

export function projectMessageMedia(message: unknown, content: readonly MessageContentItem[]) {
  const nowMs = Date.now();
  const record = asNonArrayRecord(message);
  const images: ImageBlock[] = [];
  const attachments: AssistantAttachmentItem[] = [];
  const orderedContent: ProjectedMessageContent[] = [];
  const supplementalImages: ImageBlock[] = [];
  const supplementalAttachments: AssistantAttachmentItem[] = [];
  const positionedSources = new Set<string>();
  const attachmentUrls = new Set<string>();
  let expiredPairingQrCount = 0;
  let nextPairingQrExpiresAt: number | undefined;
  const appendAttachment = (item: AssistantAttachmentItem) => {
    if (item.type === "attachment_error" || !attachmentUrls.has(item.attachment.url)) {
      attachments.push(item);
      if (item.type === "attachment") {
        attachmentUrls.add(item.attachment.url);
      }
      return true;
    }
    return false;
  };
  const projectSvgAttachment = (source: MessageImageSource): AttachmentItem | undefined => {
    if (
      !source.url ||
      !isSvgImageMediaPath(source.url, source.mimeType) ||
      !isCrossOriginHttpSource(source.url)
    ) {
      return undefined;
    }
    return {
      type: "attachment",
      attachment: {
        url: source.url,
        kind: "image",
        label: source.fileName?.trim() || source.alt?.trim() || labelForMediaPath(source.url),
        mimeType: source.mimeType ?? "image/svg+xml",
        ...(source.artifactId !== undefined ? { artifactId: source.artifactId } : {}),
        ...(source.sizeBytes !== undefined ? { sizeBytes: source.sizeBytes } : {}),
      },
    };
  };
  const layout = asNonArrayRecord(asNonArrayRecord(record["__openclaw"]).mediaImageLayout);
  const slots = Array.isArray(layout.slots) ? layout.slots.map(asNonArrayRecord) : [];
  const factIndexes = slots.length > 0 ? new Set(slots.map((slot) => slot.factIndex)) : undefined;
  // Reject ambiguous layouts before deduplication: fact positions, including
  // holes and duplicate sources, are the persisted attachment identity.
  const validLayout =
    factIndexes !== undefined &&
    !(Array.isArray(layout.suppressedFactIndexes) && layout.suppressedFactIndexes.length > 0) &&
    slots.every(
      (slot) =>
        (slot.kind === "inline" || slot.kind === "offloaded") &&
        typeof slot.factIndex === "number" &&
        Number.isSafeInteger(slot.factIndex) &&
        slot.factIndex >= 0,
    ) &&
    factIndexes.size === slots.length;
  const inlineSlots = validLayout ? slots.filter((slot) => slot.kind === "inline") : [];
  let inlineIndex = 0;

  for (const item of content) {
    if (item.type === "text" && typeof item.text === "string") {
      const previous = orderedContent.at(-1);
      if (previous?.type === "text") {
        previous.text += `\n${item.text}`;
      } else {
        orderedContent.push({ type: "text", text: item.text });
      }
      continue;
    }
    if (item.type === "attachment" || item.type === "attachment_error") {
      if (item.type === "attachment") {
        positionedSources.add(item.attachment.url);
        if (resolveAttachmentImageKind(item.attachment) === "raster") {
          // Tiles and their gallery must share the same projected image identity.
          const image = {
            ...item.attachment,
            alt: item.attachment.label,
            fileName: item.attachment.label,
          };
          images.push(image);
          orderedContent.push({ type: "image", image });
          continue;
        }
      }
      appendAttachment(item);
      orderedContent.push(item);
      continue;
    }
    if (item.type === "omitted_media") {
      inlineIndex += 1;
      continue;
    }
    if (item.type !== "image") {
      continue;
    }
    if (item.expiresAtMs !== undefined) {
      if (item.expiresAtMs <= nowMs) {
        expiredPairingQrCount += 1;
        continue;
      }
      nextPairingQrExpiresAt = Math.min(nextPairingQrExpiresAt ?? Infinity, item.expiresAtMs);
    }
    const factIndex = item.inlineSlot ? inlineSlots[inlineIndex++]?.factIndex : undefined;
    const blockImages: ImageBlock[] = [];
    const blockAttachments = new Set<string>();
    for (const source of item.sources) {
      const { url: sourceUrl, dataUrl, preferData, ...metadata } = source;
      if (sourceUrl !== undefined) {
        positionedSources.add(sourceUrl);
      }
      const svg = projectSvgAttachment(source);
      if (svg && !blockAttachments.has(svg.attachment.url)) {
        appendAttachment(svg);
        orderedContent.push(svg);
        blockAttachments.add(svg.attachment.url);
      }
      const url = preferData
        ? (dataUrl ?? (svg ? undefined : sourceUrl))
        : ((svg ? undefined : sourceUrl) ?? dataUrl);
      if (url !== undefined) {
        appendImageBlock(blockImages, {
          ...metadata,
          url,
          ...(typeof factIndex === "number" ? { factIndex } : {}),
        });
      } else if (metadata.artifactId) {
        appendImageBlock(blockImages, { ...metadata, artifactId: metadata.artifactId });
      }
    }
    // Separate blocks are separate attachments, including identical uploads.
    images.push(...blockImages);
    orderedContent.push(...blockImages.map((image) => ({ type: "image" as const, image })));
  }
  // Only a complete inline layout may lend its fact positions to mounted previews.
  if (inlineIndex !== inlineSlots.length) {
    for (const image of images) {
      delete image.factIndex;
    }
  }
  for (const {
    path: mediaPath,
    mediaType,
    fileName,
    origin,
    sizeBytes,
    durationMs,
    width,
    height,
    factIndex,
  } of readTranscriptMediaEntries(message)) {
    // Inline content owns placement; its canonical fact can supply geometry
    // before deduplication discards the mirrored attachment.
    if (width !== undefined && height !== undefined) {
      for (const image of images) {
        const matches = validLayout ? image.factIndex === factIndex : image.url === mediaPath;
        if (matches && ((image.width ?? 0) <= 0 || (image.height ?? 0) <= 0)) {
          Object.assign(image, { width, height });
        }
      }
    }
    // Without slot identity, a persisted fact mirrors the already-positioned media.
    // Valid layouts still distinguish separate uploads of the same source.
    if (!validLayout && positionedSources.has(mediaPath)) {
      continue;
    }
    const imageKind = resolveAttachmentImageKind({
      kind: "document",
      url: mediaPath,
      label: fileName?.trim() || labelForMediaPath(mediaPath),
      mimeType: mediaType,
    });
    if (imageKind === "raster") {
      const projected: ImageBlock = {
        url: mediaPath,
        fileName,
        ...(typeof mediaType === "string" ? { mimeType: mediaType } : {}),
        sizeBytes,
        width,
        height,
        ...(validLayout && factIndexes.has(factIndex) ? { factIndex } : {}),
      };
      if (appendImageBlock(images, projected) && !positionedSources.has(mediaPath)) {
        supplementalImages.push(projected);
      }
    } else {
      const projected: AttachmentItem = {
        type: "attachment",
        attachment: {
          url: mediaPath,
          kind:
            imageKind === "svg"
              ? "image"
              : isAudioTranscriptMediaPath(mediaPath, mediaType)
                ? "audio"
                : isVideoTranscriptMediaPath(mediaPath, mediaType)
                  ? "video"
                  : "document",
          label: fileName?.trim() || labelForMediaPath(mediaPath),
          ...(origin ? { origin } : {}),
          ...(typeof mediaType === "string" ? { mimeType: mediaType } : {}),
          ...(sizeBytes !== undefined ? { sizeBytes } : {}),
          ...(durationMs !== undefined ? { durationMs } : {}),
          ...(width !== undefined ? { width } : {}),
          ...(height !== undefined ? { height } : {}),
        },
      };
      if (appendAttachment(projected) && !positionedSources.has(mediaPath)) {
        supplementalAttachments.push(projected);
      }
    }
  }
  return {
    images,
    attachments,
    orderedContent,
    supplementalImages,
    supplementalAttachments,
    expiredPairingQrCount,
    nextPairingQrExpiresAt,
  };
}

export function omittedMediaReason(sizeBytes: number | undefined): string {
  return sizeBytes === undefined
    ? t("chat.attachments.omittedFromHistory")
    : t("chat.attachments.omittedFromHistoryWithSize", { size: formatBytes(sizeBytes) });
}

// Reply previews and completed-run actions describe the media the bubble renders.
export function extractMessageMediaText(
  message: unknown,
  content = normalizeMessage(message).content,
): string {
  const { images, attachments } = projectMessageMedia(message, content);
  return [
    ...images.map(
      (image) => image.fileName?.trim() || image.alt?.trim() || t("chat.imageLightbox.untitled"),
    ),
    ...content.flatMap((item) =>
      item.type === "omitted_media"
        ? [`${t("chat.attachments.image")} · ${omittedMediaReason(item.media.sizeBytes)}`]
        : [],
    ),
    ...attachments.map(
      (item) => item.attachment.label.trim() || t("chat.attachments.attachedFile"),
    ),
  ].join("\n");
}

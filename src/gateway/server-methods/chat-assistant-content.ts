import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import { normalizeReplyPayloadsForDelivery } from "../../infra/outbound/payloads.js";
import { stripInlineDirectiveTagsForDisplay } from "../../utils/directive-tags.js";
import { stripEnvelopeFromMessage } from "../chat-sanitize.js";
import { createManagedOutgoingImageBlocks } from "../managed-image-attachments.js";
import { formatForLog } from "../ws-log.js";
import { buildWebchatAudioContentBlocksFromReplyPayloads } from "./chat-webchat-media.js";

export type AssistantDisplayContentBlock = Record<string, unknown>;

const MANAGED_OUTGOING_IMAGE_PATH_PREFIX = "/api/chat/media/outgoing/";

export function sanitizeAssistantDisplayText(value?: string | null): string | undefined {
  if (!value) {
    return undefined;
  }
  const withoutEnvelope = stripEnvelopeFromMessage(value);
  const normalized = typeof withoutEnvelope === "string" ? withoutEnvelope : value;
  const stripped = stripInlineDirectiveTagsForDisplay(normalized).text.trim();
  return stripped || undefined;
}

export function extractAssistantDisplayTextFromContent(
  content?: readonly AssistantDisplayContentBlock[] | null,
): string | undefined {
  if (!Array.isArray(content) || content.length === 0) {
    return undefined;
  }
  const parts = content
    .map((block) => {
      if (block?.type !== "text" || typeof block.text !== "string") {
        return "";
      }
      return block.text.trim();
    })
    .filter(Boolean);
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

export function applyDisplayTextToAssistantContent(
  content: readonly AssistantDisplayContentBlock[] | undefined,
  displayText: string | undefined,
): AssistantDisplayContentBlock[] | undefined {
  if (!displayText) {
    return content ? [...content] : undefined;
  }
  if (!content || content.length === 0) {
    return [{ type: "text", text: displayText }];
  }
  const next = [...content];
  const textIndex = next.findIndex(
    (block) => block?.type === "text" && typeof block.text === "string",
  );
  if (textIndex === -1) {
    return [{ type: "text", text: displayText }, ...next];
  }
  next[textIndex] = {
    ...next[textIndex],
    text: displayText,
  };
  return next;
}

export async function buildAssistantDisplayContentFromReplyPayloads(params: {
  sessionKey: string;
  payloads: ReplyPayload[];
  managedImageLocalRoots?: Parameters<typeof createManagedOutgoingImageBlocks>[0]["localRoots"];
  includeSensitiveMedia?: boolean;
  onLocalAudioAccessDenied?: (message: string) => void;
  onManagedImagePrepareError?: (message: string) => void;
}): Promise<AssistantDisplayContentBlock[] | undefined> {
  const rawTextPayloadCount = params.payloads.filter(
    (payload) =>
      payload.isReasoning !== true &&
      typeof payload.text === "string" &&
      payload.text.trim().length > 0,
  ).length;
  const normalized = normalizeReplyPayloadsForDelivery(params.payloads);
  if (normalized.length === 0) {
    return rawTextPayloadCount > 0 ? [{ type: "text", text: "" }] : undefined;
  }

  const content: AssistantDisplayContentBlock[] = [];
  let strippedTextPayloadCount = 0;
  for (const payload of normalized) {
    const text = sanitizeAssistantDisplayText(payload.text);
    if (text) {
      content.push({ type: "text", text });
    } else if (typeof payload.text === "string" && payload.text.trim().length > 0) {
      strippedTextPayloadCount += 1;
    }
    if (params.includeSensitiveMedia === false && payload.sensitiveMedia === true) {
      continue;
    }
    const audioBlocks = await buildWebchatAudioContentBlocksFromReplyPayloads([payload], {
      localRoots: Array.isArray(params.managedImageLocalRoots)
        ? params.managedImageLocalRoots
        : undefined,
      onLocalAudioAccessDenied: (err) => {
        params.onLocalAudioAccessDenied?.(formatForLog(err));
      },
    });
    content.push(...audioBlocks);

    const mediaUrls = Array.from(
      new Set([
        ...(Array.isArray(payload.mediaUrls) ? payload.mediaUrls : []),
        ...(typeof payload.mediaUrl === "string" ? [payload.mediaUrl] : []),
      ]),
    );
    const imageBlocks = await createManagedOutgoingImageBlocks({
      sessionKey: params.sessionKey,
      mediaUrls,
      localRoots: params.managedImageLocalRoots,
      continueOnPrepareError: true,
      onPrepareError: (error) => {
        params.onManagedImagePrepareError?.(error.message);
      },
    });
    if (imageBlocks.length > 0) {
      content.push(...imageBlocks);
    }
  }

  if (content.length > 0) {
    return content;
  }
  return strippedTextPayloadCount > 0 ? [{ type: "text", text: "" }] : undefined;
}

export function replaceAssistantContentTextBlocks(
  content: readonly AssistantDisplayContentBlock[] | undefined,
  transcriptMediaMessage: { content: Array<Record<string, unknown>> } | null,
): AssistantDisplayContentBlock[] | undefined {
  const transcriptTextBlocks = (transcriptMediaMessage?.content ?? []).filter(
    (block): block is AssistantDisplayContentBlock =>
      Boolean(block) &&
      typeof block === "object" &&
      block.type === "text" &&
      typeof block.text === "string",
  );
  if (transcriptTextBlocks.length === 0) {
    return content ? [...content] : undefined;
  }
  if (!content || content.length === 0) {
    return [...transcriptTextBlocks];
  }
  const merged: AssistantDisplayContentBlock[] = [];
  let transcriptTextIndex = 0;
  for (const block of content) {
    if (
      block?.type === "text" &&
      typeof block.text === "string" &&
      transcriptTextIndex < transcriptTextBlocks.length
    ) {
      merged.push(transcriptTextBlocks[transcriptTextIndex++]);
      continue;
    }
    merged.push(block);
  }
  if (transcriptTextIndex < transcriptTextBlocks.length) {
    merged.unshift(...transcriptTextBlocks.slice(transcriptTextIndex));
  }
  return merged;
}

function isManagedOutgoingImageUrl(value: unknown): boolean {
  if (typeof value !== "string" || !value.trim()) {
    return false;
  }
  try {
    const parsed = new URL(value, "http://localhost");
    return parsed.pathname.startsWith(MANAGED_OUTGOING_IMAGE_PATH_PREFIX);
  } catch {
    return false;
  }
}

export function stripManagedOutgoingAssistantContentBlocks(
  content: readonly AssistantDisplayContentBlock[] | undefined,
): AssistantDisplayContentBlock[] | undefined {
  if (!content || content.length === 0) {
    return undefined;
  }
  const filtered = content.filter((block) => {
    if (block?.type !== "image") {
      return true;
    }
    return !(isManagedOutgoingImageUrl(block.url) || isManagedOutgoingImageUrl(block.openUrl));
  });
  return filtered.length > 0 ? filtered : undefined;
}

export function hasAssistantDisplayMediaContent(
  content: readonly AssistantDisplayContentBlock[] | undefined,
): boolean {
  return Boolean(content?.some((block) => block?.type !== "text"));
}

export function buildAssistantMediaFallbackText(
  content: readonly AssistantDisplayContentBlock[] | undefined,
): string | undefined {
  if (!hasAssistantDisplayMediaContent(content)) {
    return undefined;
  }
  let hasAudio = false;
  let hasImage = false;
  let hasOtherMedia = false;
  for (const block of content ?? []) {
    if (block?.type === "text") {
      continue;
    }
    if (block?.type === "image" || block?.type === "input_image") {
      hasImage = true;
      continue;
    }
    if (block?.type === "attachment") {
      const attachment =
        typeof block.attachment === "object" &&
        block.attachment !== null &&
        !Array.isArray(block.attachment)
          ? (block.attachment as Record<string, unknown>)
          : undefined;
      if (attachment?.kind === "audio") {
        hasAudio = true;
      } else {
        hasOtherMedia = true;
      }
      continue;
    }
    if (block?.type === "audio") {
      hasAudio = true;
      continue;
    }
    hasOtherMedia = true;
  }
  if (hasOtherMedia || (hasAudio && hasImage)) {
    return "Media reply";
  }
  if (hasAudio) {
    return "Audio reply";
  }
  return hasImage ? "Image reply" : undefined;
}

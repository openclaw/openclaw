import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { normalizeOutboundLocation } from "../../channels/location.js";
import type {
  ChannelMessageActionName,
  ChannelThreadingToolContext,
} from "../../channels/plugins/types.public.js";
import {
  hasInteractiveReplyBlocks,
  hasMessagePresentationBlocks,
} from "../../interactive/payload.js";

type MessageActionPolicyContextInput = {
  toolContext?: ChannelThreadingToolContext;
  messageActionAuthorization?: {
    toolContext?: ChannelThreadingToolContext;
  };
};

const SEND_TEXT_KEYS = ["message", "SendMessage", "content", "text", "caption"] as const;
const SEND_MEDIA_KEYS = ["media", "mediaUrl", "path", "filePath", "fileUrl", "image"] as const;

export function resolvePolicyToolContext(
  input: MessageActionPolicyContextInput,
): ChannelThreadingToolContext | undefined {
  return input.messageActionAuthorization === undefined
    ? input.toolContext
    : input.messageActionAuthorization.toolContext;
}

export function collectMessageAttachmentMediaHints(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const mediaUrls: string[] = [];
  const seen = new Set<string>();
  const pushMedia = (entry: unknown) => {
    const normalized = normalizeOptionalString(entry);
    if (!normalized || seen.has(normalized)) {
      return;
    }
    seen.add(normalized);
    mediaUrls.push(normalized);
  };
  for (const attachment of value) {
    if (!attachment || typeof attachment !== "object" || Array.isArray(attachment)) {
      continue;
    }
    const record = attachment as Record<string, unknown>;
    pushMedia(record.media);
    pushMedia(record.mediaUrl);
    pushMedia(record.path);
    pushMedia(record.filePath);
    pushMedia(record.fileUrl);
    pushMedia(record.url);
  }
  return mediaUrls;
}

export function assertLocationSendCanStandAlone(
  location: ReturnType<typeof normalizeOutboundLocation>,
  hasConflictingContent: boolean,
): void {
  if (location && hasConflictingContent) {
    throw new Error("Location sends cannot be combined with message text or media.");
  }
}

export function assertMessageActionPayloadBeforePolicy(
  action: ChannelMessageActionName,
  args: Record<string, unknown>,
): void {
  if (action !== "send") {
    return;
  }
  const location = normalizeOutboundLocation(args.location);
  const hasText = SEND_TEXT_KEYS.some((key) => Boolean(normalizeOptionalString(args[key])));
  const hasMedia =
    SEND_MEDIA_KEYS.some((key) => Boolean(normalizeOptionalString(args[key]))) ||
    (Array.isArray(args.mediaUrls) &&
      args.mediaUrls.some((entry) => Boolean(normalizeOptionalString(entry)))) ||
    collectMessageAttachmentMediaHints(args.attachments).length > 0;
  assertLocationSendCanStandAlone(
    location,
    hasText ||
      hasMedia ||
      hasMessagePresentationBlocks(args.presentation) ||
      hasInteractiveReplyBlocks(args.interactive),
  );
}

/**
 * Message normalization utilities for chat rendering.
 */

import { stripInboundMetadata } from "../../../../src/auto-reply/reply/strip-inbound-meta.js";
import { extractCanvasShortcodes } from "../../../../src/chat/canvas-render.js";
import {
  isToolCallContentType,
  isToolResultContentType,
  resolveToolBlockArgs,
} from "../../../../src/chat/tool-content.js";
import { mediaKindFromMime } from "../../../../src/media/constants.js";
import { splitMediaFromOutput } from "../../../../src/media/parse.js";
import { parseInlineDirectives } from "../../../../src/utils/directive-tags.js";
import type { NormalizedMessage, MessageContentItem } from "../types/chat-types.ts";
export { isToolResultMessage, normalizeRoleForGrouping } from "./role-normalizer.ts";

function coerceCanvasPreview(
  value: unknown,
):
  | Extract<NonNullable<NormalizedMessage["content"][number]>, { type: "canvas" }>["preview"]
  | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const preview = value as Record<string, unknown>;
  if (preview.kind !== "canvas" || preview.surface === "tool_card") {
    return null;
  }
  const render = preview.render === "url" ? "url" : null;
  if (!render) {
    return null;
  }
  return {
    kind: "canvas",
    surface: "assistant_message",
    render,
    ...(typeof preview.title === "string" ? { title: preview.title } : {}),
    ...(typeof preview.preferredHeight === "number"
      ? { preferredHeight: preview.preferredHeight }
      : {}),
    ...(typeof preview.url === "string" ? { url: preview.url } : {}),
    ...(typeof preview.viewId === "string" ? { viewId: preview.viewId } : {}),
    ...(typeof preview.className === "string" ? { className: preview.className } : {}),
    ...(typeof preview.style === "string" ? { style: preview.style } : {}),
  };
}

function isRenderableAssistantAttachment(url: string): boolean {
  const trimmed = url.trim();
  return (
    /^https?:\/\//i.test(trimmed) ||
    /^data:(?:image|audio|video)\//i.test(trimmed) ||
    /^\/(?:__openclaw__|media)\//.test(trimmed) ||
    trimmed.startsWith("file://") ||
    trimmed.startsWith("~") ||
    trimmed.startsWith("/") ||
    /^[a-zA-Z]:[\\/]/.test(trimmed)
  );
}

function shouldPreserveRelativeAssistantAttachment(url: string): boolean {
  const trimmed = url.trim();
  if (!trimmed) {
    return false;
  }
  return (
    !/^https?:\/\//i.test(trimmed) &&
    !/^data:(?:image|audio|video)\//i.test(trimmed) &&
    !/^\/(?:__openclaw__|media)\//.test(trimmed) &&
    !trimmed.startsWith("file://") &&
    !trimmed.startsWith("~") &&
    !trimmed.startsWith("/") &&
    !/^[a-zA-Z]:[\\/]/.test(trimmed)
  );
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
  mp4: "video/mp4",
  mov: "video/quicktime",
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  zip: "application/zip",
};

function getFileExtension(url: string): string | undefined {
  const trimmed = url.trim();
  if (!trimmed) {
    return undefined;
  }
  const source = (() => {
    try {
      if (/^https?:\/\//i.test(trimmed)) {
        return new URL(trimmed).pathname;
      }
    } catch {}
    return trimmed;
  })();
  const fileName = source.split(/[\\/]/).pop() ?? source;
  const match = /\.([a-zA-Z0-9]+)$/.exec(fileName);
  return match?.[1]?.toLowerCase();
}

function mimeTypeFromUrl(url: string): string | undefined {
  const ext = getFileExtension(url);
  return ext ? MIME_BY_EXT[ext] : undefined;
}

function inferAttachmentKind(url: string): {
  kind: "image" | "audio" | "video" | "document";
  mimeType?: string;
  label: string;
} {
  const mimeType = mimeTypeFromUrl(url);
  const kind = mediaKindFromMime(mimeType) ?? "document";
  const label = (() => {
    try {
      if (/^https?:\/\//i.test(url)) {
        const parsed = new URL(url);
        const name = parsed.pathname.split("/").pop()?.trim();
        return name || parsed.hostname || url;
      }
    } catch {}
    const name = url.split(/[\\/]/).pop()?.trim();
    return name || url;
  })();
  return { kind, mimeType, label };
}

function coerceAudioContentBlock(
  item: Record<string, unknown>,
): Extract<MessageContentItem, { type: "attachment" }> | null {
  if (item.type !== "audio") {
    return null;
  }
  const source = item.source;
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    return null;
  }
  const sourceRecord = source as Record<string, unknown>;
  const mediaType =
    typeof sourceRecord.media_type === "string" &&
    sourceRecord.media_type.trim().toLowerCase().startsWith("audio/")
      ? sourceRecord.media_type.trim()
      : "audio/mpeg";
  if (sourceRecord.type === "base64" && typeof sourceRecord.data === "string") {
    const data = sourceRecord.data.trim();
    if (!data) {
      return null;
    }
    const url = data.startsWith("data:") ? data : `data:${mediaType};base64,${data}`;
    return {
      type: "attachment",
      attachment: {
        url,
        kind: "audio",
        label: typeof item.label === "string" && item.label.trim() ? item.label.trim() : "Audio",
        mimeType: mediaType,
        ...(item.isVoiceNote === true ? { isVoiceNote: true } : {}),
      },
    };
  }
  if (sourceRecord.type === "url" && typeof sourceRecord.url === "string") {
    const url = sourceRecord.url.trim();
    if (!url) {
      return null;
    }
    return {
      type: "attachment",
      attachment: {
        url,
        kind: "audio",
        label: typeof item.label === "string" && item.label.trim() ? item.label.trim() : "Audio",
        mimeType: mediaType,
        ...(item.isVoiceNote === true ? { isVoiceNote: true } : {}),
      },
    };
  }
  return null;
}

function mergeAdjacentTextItems(items: MessageContentItem[]): MessageContentItem[] {
  const merged: MessageContentItem[] = [];
  for (const item of items) {
    const previous = merged[merged.length - 1];
    if (item.type === "text" && previous?.type === "text") {
      previous.text = [previous.text, item.text].filter((value) => value !== undefined).join("\n");
      continue;
    }
    merged.push(item);
  }
  return merged.filter((item) => item.type !== "text" || Boolean(item.text?.trim()));
}

function readTrimmedString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

const VISIBLE_ERROR_SECRET_PATTERNS: RegExp[] = [
  /\b[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD)\b\s*[=:]\s*(["']?)([^\s"'\\]+)\1/g,
  /[?&](?:access[-_]?token|auth[-_]?token|hook[-_]?token|refresh[-_]?token|api[-_]?key|client[-_]?secret|token|key|secret|password|pass|passwd|auth|signature)=([^&\s"'<>]+)/gi,
  /"(?:apiKey|token|secret|password|passwd|accessToken|refreshToken)"\s*:\s*"([^"]+)"/g,
  /--(?:api[-_]?key|hook[-_]?token|token|secret|password|passwd)\s+(["']?)([^\s"']+)\1/g,
  /Authorization\s*[:=]\s*Bearer\s+([A-Za-z0-9._\-+=]+)/gi,
  /Authorization\s*[:=]\s*Basic\s+([A-Za-z0-9+/=]+)/gi,
  /(?:X-OpenClaw-Token|x-pomerium-jwt-assertion|X-Api-Key|X-Auth-Token)\s*[:=]\s*([^\s"',;]+)/gi,
  /\bBearer\s+([A-Za-z0-9._\-+=]{18,})\b/gi,
  /(^|[\s,;])(?:access_token|refresh_token|auth[-_]?token|api[-_]?key|client[-_]?secret|token|secret|password|passwd)=([^\s&#]+)/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]+?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(sk-[A-Za-z0-9_-]{8,})\b/g,
  /\b(ghp_[A-Za-z0-9]{20,})\b/g,
  /\b(github_pat_[A-Za-z0-9_]{20,})\b/g,
  /\b(xox[baprs]-[A-Za-z0-9-]{10,})\b/g,
  /\b(xapp-[A-Za-z0-9-]{10,})\b/g,
  /\b(gsk_[A-Za-z0-9_-]{10,})\b/g,
  /\b(AIza[0-9A-Za-z\-_]{20,})\b/g,
  /\b(ya29\.[0-9A-Za-z_\-./+=]{10,})\b/g,
  /\b(1\/\/0[0-9A-Za-z_\-./+=]{10,})\b/g,
  /\b(pplx-[A-Za-z0-9_-]{10,})\b/g,
  /\b(npm_[A-Za-z0-9]{10,})\b/g,
  /\bbot(\d{6,}:[A-Za-z0-9_-]{20,})\b/g,
  /\b(\d{6,}:[A-Za-z0-9_-]{20,})\b/g,
];

function maskVisibleSecret(token: string): string {
  if (token.length < 18) {
    return "***";
  }
  return `${token.slice(0, 6)}...${token.slice(-4)}`;
}

function redactVisibleErrorMatch(match: string, groups: string[]): string {
  if (match.includes("PRIVATE KEY-----")) {
    const lines = match.split(/\r?\n/).filter(Boolean);
    if (lines.length < 2) {
      return "***";
    }
    return `${lines[0]}\n...redacted...\n${lines[lines.length - 1]}`;
  }
  let token = match;
  for (let index = groups.length - 1; index >= 0; index -= 1) {
    const value = groups[index];
    if (typeof value === "string" && value.length > 0) {
      token = value;
      break;
    }
  }
  const masked = maskVisibleSecret(token);
  return token === match ? masked : match.replace(token, masked);
}

function redactVisibleErrorText(text: string): string {
  let next = text;
  for (const pattern of VISIBLE_ERROR_SECRET_PATTERNS) {
    next = next.replace(pattern, (...args: string[]) =>
      redactVisibleErrorMatch(args[0] ?? "", args.slice(1, -2)),
    );
  }
  return next;
}

function fallbackAssistantErrorContent(
  message: Record<string, unknown>,
  content: MessageContentItem[],
): MessageContentItem[] {
  if (content.length > 0) {
    return content;
  }
  if (message.stopReason !== "error") {
    return content;
  }
  const errorText =
    readTrimmedString(message.errorMessage) ?? "Assistant turn failed before producing content.";
  const provider = readTrimmedString(message.provider);
  const model = readTrimmedString(message.model);
  const target = provider && model ? ` (${provider}/${model})` : "";
  return [
    {
      type: "text",
      text: `Assistant failed${target}: ${redactVisibleErrorText(errorText)}`,
    },
  ];
}

export function stripMessageDisplayMetadataText(text: string): string {
  return stripInboundMetadata(text);
}

function stripMessageDisplayMetadata(items: MessageContentItem[]): MessageContentItem[] {
  return items
    .map((item) => {
      if (item.type !== "text" || typeof item.text !== "string") {
        return item;
      }
      return { ...item, text: stripMessageDisplayMetadataText(item.text) };
    })
    .filter((item) => item.type !== "text" || Boolean(item.text?.trim()));
}

function expandTextContent(text: string): {
  content: MessageContentItem[];
  audioAsVoice: boolean;
  replyTarget: NormalizedMessage["replyTarget"];
} {
  const extracted = extractCanvasShortcodes(text);
  const parsed = splitMediaFromOutput(extracted.text);
  const parts: MessageContentItem[] = [];
  let audioAsVoice = parsed.audioAsVoice === true;
  let replyTarget: NormalizedMessage["replyTarget"] = null;
  const segments = parsed.segments ?? [{ type: "text" as const, text: parsed.text }];

  for (const segment of segments) {
    if (segment.type === "media") {
      if (!isRenderableAssistantAttachment(segment.url)) {
        if (shouldPreserveRelativeAssistantAttachment(segment.url)) {
          parts.push({ type: "text", text: `MEDIA:${segment.url}` });
        }
        continue;
      }
      const inferred = inferAttachmentKind(segment.url);
      parts.push({
        type: "attachment",
        attachment: {
          url: segment.url,
          kind: inferred.kind,
          label: inferred.label,
          mimeType: inferred.mimeType,
        },
      });
      continue;
    }

    const directives = parseInlineDirectives(segment.text, {
      stripAudioTag: true,
      stripReplyTags: true,
    });
    audioAsVoice = audioAsVoice || directives.audioAsVoice;
    if (directives.replyToExplicitId) {
      replyTarget = { kind: "id", id: directives.replyToExplicitId };
    } else if (directives.replyToCurrent && replyTarget === null) {
      replyTarget = { kind: "current" };
    }
    if (directives.text) {
      parts.push({ type: "text", text: directives.text });
    }
  }
  for (const preview of extracted.previews) {
    parts.push({ type: "canvas", preview, rawText: null });
  }

  const content = mergeAdjacentTextItems(
    parts.map((item) => {
      if (item.type === "attachment" && item.attachment.kind === "audio" && audioAsVoice) {
        return Object.assign({}, item, { attachment: { ...item.attachment, isVoiceNote: true } });
      }
      return item;
    }),
  );

  return {
    content:
      content.length > 0
        ? content
        : (parsed.mediaUrls ?? []).some((url) => shouldPreserveRelativeAssistantAttachment(url))
          ? (parsed.mediaUrls ?? [])
              .filter((url) => shouldPreserveRelativeAssistantAttachment(url))
              .map((url) => ({ type: "text" as const, text: `MEDIA:${url}` }))
          : replyTarget === null && !audioAsVoice && parsed.text.trim().length > 0
            ? [{ type: "text", text: parsed.text }]
            : [],
    audioAsVoice,
    replyTarget,
  };
}

/**
 * Normalize a raw message object into a consistent structure.
 */
export function normalizeMessage(message: unknown): NormalizedMessage {
  const m = message as Record<string, unknown>;
  let role = typeof m.role === "string" ? m.role : "unknown";

  // Detect tool messages by common gateway shapes.
  // Some tool events come through as assistant role with tool_* items in the content array.
  const hasToolId = typeof m.toolCallId === "string" || typeof m.tool_call_id === "string";

  const contentRaw = m.content;
  const contentItems = Array.isArray(contentRaw) ? contentRaw : null;
  const hasToolContent =
    Array.isArray(contentItems) &&
    contentItems.some((item) => {
      const x = item as Record<string, unknown>;
      return isToolResultContentType(x.type) || isToolCallContentType(x.type);
    });

  const hasToolName = typeof m.toolName === "string" || typeof m.tool_name === "string";

  if (hasToolId || hasToolContent || hasToolName) {
    role = "toolResult";
  }
  const isAssistantMessage = role === "assistant";

  // Extract content
  let content: MessageContentItem[] = [];
  let audioAsVoice = false;
  let replyTarget: NormalizedMessage["replyTarget"] = null;

  if (typeof m.content === "string") {
    if (isAssistantMessage) {
      const expanded = expandTextContent(m.content);
      content = expanded.content;
      audioAsVoice = expanded.audioAsVoice;
      replyTarget = expanded.replyTarget;
    } else {
      content = [{ type: "text", text: m.content }];
    }
  } else if (Array.isArray(m.content)) {
    content = m.content.flatMap((item: Record<string, unknown>) => {
      if (isAssistantMessage) {
        const audioAttachment = coerceAudioContentBlock(item);
        if (audioAttachment) {
          return [audioAttachment];
        }
      } else if (item.type === "audio") {
        return [];
      }
      if (
        item.type === "attachment" &&
        item.attachment &&
        typeof item.attachment === "object" &&
        !Array.isArray(item.attachment)
      ) {
        const attachment = item.attachment as {
          url?: unknown;
          kind?: unknown;
          label?: unknown;
          mimeType?: unknown;
          isVoiceNote?: unknown;
        };
        if (
          typeof attachment.url !== "string" ||
          (attachment.kind !== "image" &&
            attachment.kind !== "audio" &&
            attachment.kind !== "video" &&
            attachment.kind !== "document") ||
          typeof attachment.label !== "string"
        ) {
          return [];
        }
        return [
          {
            type: "attachment" as const,
            attachment: {
              url: attachment.url,
              kind: attachment.kind,
              label: attachment.label,
              ...(typeof attachment.mimeType === "string" ? { mimeType: attachment.mimeType } : {}),
              ...(attachment.isVoiceNote === true ? { isVoiceNote: true } : {}),
            },
          },
        ];
      }
      if (
        item.type === "canvas" &&
        item.preview &&
        typeof item.preview === "object" &&
        !Array.isArray(item.preview)
      ) {
        const preview = coerceCanvasPreview(item.preview);
        if (!preview) {
          return [];
        }
        return [
          {
            type: "canvas" as const,
            preview,
            rawText: typeof item.rawText === "string" ? item.rawText : null,
          },
        ];
      }
      if (item.type === "text" && typeof item.text === "string" && isAssistantMessage) {
        const expanded = expandTextContent(item.text);
        audioAsVoice = audioAsVoice || expanded.audioAsVoice;
        if (expanded.replyTarget?.kind === "id") {
          replyTarget = expanded.replyTarget;
        } else if (expanded.replyTarget?.kind === "current" && replyTarget === null) {
          replyTarget = expanded.replyTarget;
        }
        return expanded.content;
      }
      return [
        {
          type:
            (item.type as Extract<
              MessageContentItem,
              { type: "text" | "tool_call" | "tool_result" }
            >["type"]) || "text",
          text: item.text as string | undefined,
          name: item.name as string | undefined,
          args: resolveToolBlockArgs(item),
        },
      ];
    });
  } else if (typeof m.text === "string") {
    if (isAssistantMessage) {
      const expanded = expandTextContent(m.text);
      content = expanded.content;
      audioAsVoice = expanded.audioAsVoice;
      replyTarget = expanded.replyTarget;
    } else {
      content = [{ type: "text", text: m.text }];
    }
  }

  const timestamp = typeof m.timestamp === "number" ? m.timestamp : Date.now();
  const id = typeof m.id === "string" ? m.id : undefined;
  const senderLabel =
    typeof m.senderLabel === "string" && m.senderLabel.trim() ? m.senderLabel.trim() : null;

  content = stripMessageDisplayMetadata(content);
  if (isAssistantMessage) {
    content = fallbackAssistantErrorContent(m, content);
  }

  return {
    role,
    content,
    timestamp,
    id,
    senderLabel,
    ...(audioAsVoice ? { audioAsVoice: true } : {}),
    ...(replyTarget ? { replyTarget } : {}),
  };
}

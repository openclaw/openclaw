import { lstat } from "node:fs/promises";
import { extractDeliveryInfo } from "../config/sessions/delivery-info.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { detectMime, normalizeMimeType } from "../media/mime.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import type {
  PluginAttachmentChannelHints,
  PluginSessionAttachmentCaptionFormat,
  PluginSessionAttachmentParams,
  PluginSessionAttachmentResult,
} from "./host-hooks.js";
import type { PluginOrigin } from "./plugin-origin.types.js";

const DEFAULT_ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;
const MAX_ATTACHMENT_FILES = 10;

type SendMessage = typeof import("../infra/outbound/message.js").sendMessage;
let sendMessagePromise: Promise<SendMessage> | undefined;

async function loadSendMessage(): Promise<SendMessage> {
  sendMessagePromise ??= import("../infra/outbound/message.js").then(
    (module) => module.sendMessage,
  );
  return sendMessagePromise;
}

type ResolvedAttachmentDelivery = {
  parseMode?: "HTML";
  escapePlainHtmlCaption?: boolean;
  disableNotification?: boolean;
  forceDocumentMime?: string;
  threadTs?: string;
};

function captionFormatToParseMode(
  captionFormat: PluginSessionAttachmentCaptionFormat | undefined,
): "HTML" | undefined {
  if (captionFormat === "html") {
    return "HTML";
  }
  return undefined;
}

function escapeHtmlText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function resolveAttachmentDelivery(params: {
  channel: string;
  captionFormat?: PluginSessionAttachmentCaptionFormat;
  channelHints?: PluginAttachmentChannelHints;
}): ResolvedAttachmentDelivery {
  const fallbackParseMode = captionFormatToParseMode(params.captionFormat);
  const channel = params.channel.trim().toLowerCase();
  if (channel === "telegram") {
    const hint = params.channelHints?.telegram;
    const parseMode =
      hint?.parseMode ?? (params.captionFormat === "plain" ? "HTML" : fallbackParseMode);
    const escapePlainHtmlCaption = params.captionFormat === "plain" && parseMode === "HTML";
    const forceDocumentMime = normalizeMimeType(hint?.forceDocumentMime);
    return {
      ...(parseMode ? { parseMode } : {}),
      ...(escapePlainHtmlCaption ? { escapePlainHtmlCaption: true } : {}),
      ...(hint?.disableNotification !== undefined
        ? { disableNotification: hint.disableNotification }
        : {}),
      ...(forceDocumentMime ? { forceDocumentMime } : {}),
    };
  }
  if (channel === "discord") {
    return fallbackParseMode ? { parseMode: fallbackParseMode } : {};
  }
  if (channel === "slack") {
    const hint = params.channelHints?.slack;
    return {
      ...(fallbackParseMode ? { parseMode: fallbackParseMode } : {}),
      ...(hint?.threadTs ? { threadTs: hint.threadTs } : {}),
    };
  }
  return fallbackParseMode ? { parseMode: fallbackParseMode } : {};
}

async function validateAttachmentFiles(
  files: PluginSessionAttachmentParams["files"],
  maxBytes: number,
  options?: { forceDocumentMime?: string },
): Promise<string[] | { error: string }> {
  if (files.length > MAX_ATTACHMENT_FILES) {
    return { error: `at most ${MAX_ATTACHMENT_FILES} attachment files are allowed` };
  }
  const paths: string[] = [];
  let totalBytes = 0;
  for (const file of files) {
    if (!file || typeof file !== "object" || Array.isArray(file)) {
      return { error: "attachment file entry must be an object" };
    }
    const filePath = normalizeOptionalString((file as { path?: unknown }).path);
    if (!filePath) {
      return { error: "attachment file path is required" };
    }
    const info = await lstat(filePath).catch(() => undefined);
    if (info?.isSymbolicLink()) {
      return { error: `attachment file symlinks are not allowed: ${filePath}` };
    }
    if (!info?.isFile()) {
      return { error: `attachment file not found: ${filePath}` };
    }
    if (options?.forceDocumentMime) {
      const detectedMime = normalizeMimeType(await detectMime({ filePath }));
      if (detectedMime !== options.forceDocumentMime) {
        return {
          error:
            `attachment file MIME mismatch for ${filePath}: ` +
            `expected ${options.forceDocumentMime}, got ${detectedMime ?? "unknown"}`,
        };
      }
    }
    if (info.size > maxBytes) {
      return { error: `attachment file exceeds ${maxBytes} bytes: ${filePath}` };
    }
    totalBytes += info.size;
    if (totalBytes > maxBytes) {
      return { error: `attachment files exceed ${maxBytes} bytes total` };
    }
    paths.push(filePath);
  }
  return paths;
}

function normalizeOptionalThreadId(value: unknown): string | number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  return normalizeOptionalString(value);
}

export async function sendPluginSessionAttachment(
  params: PluginSessionAttachmentParams & { config?: OpenClawConfig; origin?: PluginOrigin },
): Promise<PluginSessionAttachmentResult> {
  if (params.origin !== "bundled") {
    return { ok: false, error: "session attachments are restricted to bundled plugins" };
  }
  const sessionKey = normalizeOptionalString(params.sessionKey);
  if (!sessionKey) {
    return { ok: false, error: "sessionKey is required" };
  }
  if (!Array.isArray(params.files) || params.files.length === 0) {
    return { ok: false, error: "at least one attachment file is required" };
  }
  const maxBytes =
    typeof params.maxBytes === "number" && Number.isFinite(params.maxBytes)
      ? Math.min(DEFAULT_ATTACHMENT_MAX_BYTES, Math.max(1, Math.floor(params.maxBytes)))
      : DEFAULT_ATTACHMENT_MAX_BYTES;
  const { deliveryContext, threadId } = extractDeliveryInfo(sessionKey, { cfg: params.config });
  if (!deliveryContext?.channel || !deliveryContext.to) {
    return { ok: false, error: `session has no active delivery route: ${sessionKey}` };
  }
  const rawText = normalizeOptionalString(params.text) ?? "";
  const explicitThreadId = normalizeOptionalThreadId(params.threadId);
  const deliveryThreadId = normalizeOptionalThreadId(deliveryContext.threadId);
  const fallbackThreadId = normalizeOptionalThreadId(threadId);
  const resolvedDelivery = resolveAttachmentDelivery({
    channel: deliveryContext.channel,
    captionFormat: params.captionFormat,
    channelHints: params.channelHints,
  });
  const validated = await validateAttachmentFiles(params.files, maxBytes, {
    forceDocumentMime: resolvedDelivery.forceDocumentMime,
  });
  if (!Array.isArray(validated)) {
    return { ok: false, error: validated.error };
  }
  const resolvedThreadId =
    resolvedDelivery.threadTs ?? explicitThreadId ?? fallbackThreadId ?? deliveryThreadId;
  let result: Awaited<ReturnType<SendMessage>>;
  try {
    const sendMessage = await loadSendMessage();
    result = await sendMessage({
      to: deliveryContext.to,
      content: resolvedDelivery.escapePlainHtmlCaption ? escapeHtmlText(rawText) : rawText,
      channel: deliveryContext.channel,
      accountId: deliveryContext.accountId,
      threadId: resolvedThreadId,
      requesterSessionKey: sessionKey,
      mediaUrls: validated,
      forceDocument:
        params.forceDocument ?? (resolvedDelivery.forceDocumentMime ? true : undefined),
      bestEffort: true,
      ...(resolvedDelivery.parseMode ? { parseMode: resolvedDelivery.parseMode } : {}),
      ...(resolvedDelivery.disableNotification !== undefined
        ? { silent: resolvedDelivery.disableNotification }
        : {}),
    });
  } catch (error) {
    return { ok: false, error: `attachment delivery failed: ${formatErrorMessage(error)}` };
  }
  if (!result.result) {
    return { ok: false, error: "attachment delivery failed: no delivery result returned" };
  }
  return {
    ok: true,
    channel: result.channel,
    deliveredTo: deliveryContext.to,
    count: validated.length,
  };
}

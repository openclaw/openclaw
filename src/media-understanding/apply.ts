import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { ClawdbotConfig } from "../config/config.js";
import type { MsgContext } from "../auto-reply/templating.js";
import { resolveApiKeyForProvider } from "../agents/model-auth.js";
import { logVerbose, shouldLogVerbose } from "../globals.js";
import { fetchRemoteMedia } from "../media/fetch.js";
import { detectMime, getFileExtension, isAudioFileName } from "../media/mime.js";
import { extractMediaUserText, formatMediaUnderstandingBody } from "./format.js";
import {
  buildMediaUnderstandingRegistry,
  getMediaUnderstandingProvider,
  normalizeMediaProviderId,
} from "./providers/index.js";
import { fetchWithTimeout } from "./providers/shared.js";
import { normalizeMediaUnderstandingChatType, resolveMediaUnderstandingScope } from "./scope.js";
import type {
  MediaAttachment,
  MediaUnderstandingOutput,
  MediaUnderstandingProvider,
} from "./types.js";

const DEFAULT_AUDIO_MAX_BYTES = 20 * 1024 * 1024;
const DEFAULT_VIDEO_MAX_BYTES = 50 * 1024 * 1024;
const DEFAULT_VIDEO_MAX_BASE64_BYTES = 70 * 1024 * 1024;
const DEFAULT_AUDIO_TIMEOUT_SECONDS = 60;
const DEFAULT_VIDEO_TIMEOUT_SECONDS = 120;
const DEFAULT_AUDIO_MODELS: Record<string, string> = {
  groq: "whisper-large-v3-turbo",
  openai: "whisper-1",
};

type MediaBufferResult = {
  buffer: Buffer;
  mime?: string;
  fileName: string;
};

export type ApplyMediaUnderstandingResult = {
  outputs: MediaUnderstandingOutput[];
  appliedAudio: boolean;
  appliedVideo: boolean;
};

function normalizeAttachmentPath(raw?: string | null): string | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  if (value.startsWith("file://")) {
    try {
      return fileURLToPath(value);
    } catch {
      return undefined;
    }
  }
  return value;
}

function normalizeAttachments(ctx: MsgContext): MediaAttachment[] {
  const pathsFromArray = Array.isArray(ctx.MediaPaths) ? ctx.MediaPaths : undefined;
  const urlsFromArray = Array.isArray(ctx.MediaUrls) ? ctx.MediaUrls : undefined;
  const typesFromArray = Array.isArray(ctx.MediaTypes) ? ctx.MediaTypes : undefined;

  if (pathsFromArray && pathsFromArray.length > 0) {
    const count = pathsFromArray.length;
    const urls =
      urlsFromArray && urlsFromArray.length === count
        ? urlsFromArray
        : undefined;
    const types =
      typesFromArray && typesFromArray.length === count
        ? typesFromArray
        : undefined;
    return pathsFromArray
      .map((value, index) => ({
        path: value?.trim() || undefined,
        url: urls?.[index] ?? ctx.MediaUrl,
        mime: types?.[index] || (count === 1 ? ctx.MediaType : undefined),
        index,
      }))
      .filter((entry) => Boolean(entry.path?.trim() || entry.url?.trim()));
  }

  if (urlsFromArray && urlsFromArray.length > 0) {
    const count = urlsFromArray.length;
    const types =
      typesFromArray && typesFromArray.length === count
        ? typesFromArray
        : undefined;
    return urlsFromArray
      .map((value, index) => ({
        path: undefined,
        url: value?.trim() || undefined,
        mime: types?.[index] || (count === 1 ? ctx.MediaType : undefined),
        index,
      }))
      .filter((entry) => Boolean(entry.url?.trim()));
  }

  const path = ctx.MediaPath?.trim();
  const url = ctx.MediaUrl?.trim();
  if (!path && !url) return [];
  return [
    {
      path: path || undefined,
      url: url || undefined,
      mime: ctx.MediaType,
      index: 0,
    },
  ];
}

function isVideoAttachment(attachment: MediaAttachment): boolean {
  if (attachment.mime?.startsWith("video/")) return true;
  const ext = getFileExtension(attachment.path ?? attachment.url);
  if (!ext) return false;
  return [".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v"].includes(ext);
}

function isAudioAttachment(attachment: MediaAttachment): boolean {
  if (attachment.mime?.startsWith("audio/")) return true;
  return isAudioFileName(attachment.path ?? attachment.url);
}

function estimateBase64Size(bytes: number): number {
  return Math.ceil(bytes / 3) * 4;
}

function resolveVideoMaxBase64Bytes(maxBytes: number): number {
  const expanded = Math.floor(maxBytes * (4 / 3));
  return Math.min(expanded, DEFAULT_VIDEO_MAX_BASE64_BYTES);
}

async function loadAttachmentBuffer(params: {
  attachment: MediaAttachment;
  maxBytes: number;
  timeoutMs: number;
}): Promise<MediaBufferResult | undefined> {
  const { attachment, maxBytes, timeoutMs } = params;
  const rawPath = normalizeAttachmentPath(attachment.path);
  if (rawPath) {
    const resolved = path.isAbsolute(rawPath) ? rawPath : path.resolve(rawPath);
    try {
      const stat = await fs.stat(resolved);
      if (!stat.isFile()) return undefined;
      if (stat.size > maxBytes) {
        if (shouldLogVerbose()) {
          logVerbose(
            `Skipping media attachment ${attachment.index + 1}: ${stat.size} bytes exceeds ${maxBytes}`,
          );
        }
        return undefined;
      }
      const buffer = await fs.readFile(resolved);
      const mime =
        attachment.mime ??
        (await detectMime({
          buffer,
          filePath: resolved,
        }));
      const fileName = path.basename(resolved) || `media-${attachment.index + 1}`;
      return { buffer, mime, fileName };
    } catch (err) {
      if (shouldLogVerbose()) {
        logVerbose(`Failed to read attachment ${attachment.index + 1}: ${String(err)}`);
      }
      return undefined;
    }
  }

  const url = attachment.url?.trim();
  if (!url) return undefined;

  try {
    const fetchImpl = (input: RequestInfo | URL, init?: RequestInit) =>
      fetchWithTimeout(String(input), init ?? {}, timeoutMs, fetch);
    const fetched = await fetchRemoteMedia({ url, fetchImpl, maxBytes });
    if (fetched.buffer.length > maxBytes) {
      if (shouldLogVerbose()) {
        logVerbose(
          `Skipping media attachment ${attachment.index + 1}: ${fetched.buffer.length} bytes exceeds ${maxBytes}`,
        );
      }
      return undefined;
    }
    const mime =
      attachment.mime ??
      fetched.contentType ??
      (await detectMime({
        buffer: fetched.buffer,
        filePath: fetched.fileName ?? url,
      }));
    const fileName = fetched.fileName ?? `media-${attachment.index + 1}`;
    return { buffer: fetched.buffer, mime, fileName };
  } catch (err) {
    if (shouldLogVerbose()) {
      logVerbose(`Failed to fetch attachment ${attachment.index + 1}: ${String(err)}`);
    }
    return undefined;
  }
}

async function resolveProvider(
  id: string,
  registry: Map<string, MediaUnderstandingProvider>,
): Promise<MediaUnderstandingProvider | undefined> {
  return getMediaUnderstandingProvider(id, registry);
}

function resolveTimeoutMs(seconds: number | undefined, fallbackSeconds: number): number {
  const value = typeof seconds === "number" && Number.isFinite(seconds) ? seconds : fallbackSeconds;
  return Math.max(1000, Math.floor(value * 1000));
}

export async function applyMediaUnderstanding(params: {
  ctx: MsgContext;
  cfg: ClawdbotConfig;
  agentDir?: string;
  providers?: Record<string, MediaUnderstandingProvider>;
}): Promise<ApplyMediaUnderstandingResult> {
  const { ctx, cfg } = params;
  const commandCandidates = [ctx.CommandBody, ctx.RawBody, ctx.Body];
  const originalUserText =
    commandCandidates
      .map((value) => extractMediaUserText(value))
      .find((value) => value && value.trim()) ?? undefined;
  const registry = buildMediaUnderstandingRegistry(params.providers);
  const outputs: MediaUnderstandingOutput[] = [];
  const attachments = normalizeAttachments(ctx);
  const channel = ctx.Surface ?? ctx.Provider;
  const chatType = normalizeMediaUnderstandingChatType(ctx.ChatType);
  const sessionKey = ctx.SessionKey;

  const audioCfg = cfg.tools?.audio?.transcription;
  const audioProviderRaw = audioCfg?.provider?.trim();
  const audioEnabled = audioCfg?.enabled !== false && Boolean(audioProviderRaw);
  if (audioEnabled) {
      const decision = resolveMediaUnderstandingScope({
        scope: audioCfg?.scope,
        sessionKey,
        channel,
        chatType,
    });
    if (decision === "deny") {
      if (shouldLogVerbose()) {
        logVerbose("Audio transcription disabled by scope policy.");
      }
    } else {
      const attachment = attachments.find((item) => isAudioAttachment(item));
      if (attachment) {
        const providerId = normalizeMediaProviderId(audioProviderRaw ?? "");
        const provider = await resolveProvider(providerId, registry);
        if (!provider?.transcribeAudio) {
          logVerbose(`Audio transcription provider "${providerId}" not available.`);
        } else {
          try {
            const timeoutMs = resolveTimeoutMs(
              audioCfg?.timeoutSeconds,
              DEFAULT_AUDIO_TIMEOUT_SECONDS,
            );
            const maxBytes =
              typeof audioCfg?.maxBytes === "number" && audioCfg.maxBytes > 0
                ? audioCfg.maxBytes
                : DEFAULT_AUDIO_MAX_BYTES;
            const media = await loadAttachmentBuffer({
              attachment,
              maxBytes,
              timeoutMs,
            });
            if (media) {
              const key = await resolveApiKeyForProvider({
                provider: providerId,
                cfg,
                profileId: audioCfg?.profile,
                preferredProfile: audioCfg?.preferredProfile,
                agentDir: params.agentDir,
              });
              const providerConfig = cfg.models?.providers?.[providerId];
              const resolvedModel =
                audioCfg?.model?.trim() || DEFAULT_AUDIO_MODELS[providerId];
              const result = await provider.transcribeAudio({
                buffer: media.buffer,
                fileName: media.fileName,
                mime: media.mime,
                apiKey: key.apiKey,
                baseUrl: providerConfig?.baseUrl,
                headers: providerConfig?.headers,
                model: resolvedModel,
                language: audioCfg?.language,
                prompt: audioCfg?.prompt,
                timeoutMs,
              });
              outputs.push({
                kind: "audio.transcription",
                attachmentIndex: attachment.index,
                text: result.text,
                provider: providerId,
                model: result.model ?? resolvedModel,
              });
            }
          } catch (err) {
            if (shouldLogVerbose()) {
              logVerbose(`Audio transcription failed: ${String(err)}`);
            }
          }
        }
      }
    }
  }

  const videoCfg = cfg.tools?.video?.understanding;
  const videoProviderRaw = videoCfg?.provider?.trim();
  const videoEnabled = videoCfg?.enabled !== false && Boolean(videoProviderRaw);
  if (videoEnabled) {
      const decision = resolveMediaUnderstandingScope({
        scope: videoCfg?.scope,
        sessionKey,
        channel,
        chatType,
    });
    if (decision === "deny") {
      if (shouldLogVerbose()) {
        logVerbose("Video understanding disabled by scope policy.");
      }
    } else {
      const attachment = attachments.find((item) => isVideoAttachment(item));
      if (attachment) {
        const providerId = normalizeMediaProviderId(videoProviderRaw ?? "");
        const provider = await resolveProvider(providerId, registry);
        if (!provider?.describeVideo) {
          logVerbose(`Video understanding provider "${providerId}" not available.`);
        } else {
          try {
            const timeoutMs = resolveTimeoutMs(
              videoCfg?.timeoutSeconds,
              DEFAULT_VIDEO_TIMEOUT_SECONDS,
            );
            const maxBytes =
              typeof videoCfg?.maxBytes === "number" && videoCfg.maxBytes > 0
                ? videoCfg.maxBytes
                : DEFAULT_VIDEO_MAX_BYTES;
            const media = await loadAttachmentBuffer({
              attachment,
              maxBytes,
              timeoutMs,
            });
            if (media) {
              const estimatedBase64Bytes = estimateBase64Size(media.buffer.length);
              const maxBase64Bytes = resolveVideoMaxBase64Bytes(maxBytes);
              if (estimatedBase64Bytes > maxBase64Bytes) {
                if (shouldLogVerbose()) {
                  logVerbose(
                    `Skipping video attachment ${attachment.index + 1}: base64 payload ${estimatedBase64Bytes} exceeds ${maxBase64Bytes}`,
                  );
                }
              } else {
              const key = await resolveApiKeyForProvider({
                provider: providerId,
                cfg,
                profileId: videoCfg?.profile,
                preferredProfile: videoCfg?.preferredProfile,
                agentDir: params.agentDir,
              });
              const providerConfig = cfg.models?.providers?.[providerId];
              const result = await provider.describeVideo({
                buffer: media.buffer,
                fileName: media.fileName,
                mime: media.mime,
                apiKey: key.apiKey,
                baseUrl: providerConfig?.baseUrl,
                headers: providerConfig?.headers,
                model: videoCfg?.model,
                prompt: videoCfg?.prompt,
                timeoutMs,
              });
              outputs.push({
                kind: "video.description",
                attachmentIndex: attachment.index,
                text: result.text,
                provider: providerId,
                model: result.model ?? videoCfg?.model,
              });
              }
            }
          } catch (err) {
            if (shouldLogVerbose()) {
              logVerbose(`Video understanding failed: ${String(err)}`);
            }
          }
        }
      }
    }
  }

  if (outputs.length > 0) {
    ctx.Body = formatMediaUnderstandingBody({ body: ctx.Body, outputs });
    const audioOutput = outputs.find((output) => output.kind === "audio.transcription");
    if (audioOutput) {
      ctx.Transcript = audioOutput.text;
      ctx.CommandBody = audioOutput.text;
      if (!ctx.RawBody) {
        ctx.RawBody = audioOutput.text;
      }
    } else if (originalUserText) {
      ctx.CommandBody = originalUserText;
      if (!extractMediaUserText(ctx.RawBody)) {
        ctx.RawBody = originalUserText;
      }
    }
    ctx.MediaUnderstanding = [...(ctx.MediaUnderstanding ?? []), ...outputs];
  }

  return {
    outputs,
    appliedAudio: outputs.some((output) => output.kind === "audio.transcription"),
    appliedVideo: outputs.some((output) => output.kind === "video.description"),
  };
}

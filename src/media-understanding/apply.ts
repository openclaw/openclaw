import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { Api, AssistantMessage, Context, Model } from "@mariozechner/pi-ai";
import { complete } from "@mariozechner/pi-ai";
import { discoverAuthStorage, discoverModels } from "@mariozechner/pi-coding-agent";

import type { ClawdbotConfig } from "../config/config.js";
import type { MsgContext } from "../auto-reply/templating.js";
import { applyTemplate } from "../auto-reply/templating.js";
import { getApiKeyForModel, resolveApiKeyForProvider } from "../agents/model-auth.js";
import { ensureClawdbotModelsJson } from "../agents/models-config.js";
import { minimaxUnderstandImage } from "../agents/minimax-vlm.js";
import { logVerbose, shouldLogVerbose } from "../globals.js";
import { fetchRemoteMedia } from "../media/fetch.js";
import { detectMime, getFileExtension, isAudioFileName } from "../media/mime.js";
import { runExec } from "../process/exec.js";
import type {
  MediaUnderstandingConfig,
  MediaUnderstandingModelConfig,
  MediaUnderstandingScopeConfig,
} from "../config/types.tools.js";
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
import { coerceImageAssistantText } from "../agents/tools/image-tool.helpers.js";

const MB = 1024 * 1024;
const DEFAULT_MAX_CHARS = 500;
const DEFAULT_MAX_CHARS_BY_CAPABILITY: Record<Capability, number | undefined> = {
  image: DEFAULT_MAX_CHARS,
  audio: undefined,
  video: DEFAULT_MAX_CHARS,
};
const DEFAULT_MAX_BYTES: Record<Capability, number> = {
  image: 10 * MB,
  audio: 20 * MB,
  video: 50 * MB,
};
const DEFAULT_TIMEOUT_SECONDS: Record<Capability, number> = {
  image: 60,
  audio: 60,
  video: 120,
};
const DEFAULT_PROMPT: Record<Capability, string> = {
  image: "Describe the image.",
  audio: "Transcribe the audio.",
  video: "Describe the video.",
};
const DEFAULT_VIDEO_MAX_BASE64_BYTES = 70 * MB;
const DEFAULT_AUDIO_MODELS: Record<string, string> = {
  groq: "whisper-large-v3-turbo",
  openai: "whisper-1",
};
const CLI_OUTPUT_MAX_BUFFER = 5 * MB;

export type ApplyMediaUnderstandingResult = {
  outputs: MediaUnderstandingOutput[];
  appliedImage: boolean;
  appliedAudio: boolean;
  appliedVideo: boolean;
};

type Capability = "image" | "audio" | "video";

type MediaBufferResult = {
  buffer: Buffer;
  mime?: string;
  fileName: string;
};

type MediaPathResult = {
  path: string;
  cleanup?: () => Promise<void> | void;
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
  const resolveMime = (count: number, index: number) => {
    const typeHint = typesFromArray?.[index];
    const trimmed = typeof typeHint === "string" ? typeHint.trim() : "";
    if (trimmed) return trimmed;
    return count === 1 ? ctx.MediaType : undefined;
  };

  if (pathsFromArray && pathsFromArray.length > 0) {
    const count = pathsFromArray.length;
    const urls = urlsFromArray && urlsFromArray.length > 0 ? urlsFromArray : undefined;
    return pathsFromArray
      .map((value, index) => ({
        path: value?.trim() || undefined,
        url: urls?.[index] ?? ctx.MediaUrl,
        mime: resolveMime(count, index),
        index,
      }))
      .filter((entry) => Boolean(entry.path?.trim() || entry.url?.trim()));
  }

  if (urlsFromArray && urlsFromArray.length > 0) {
    const count = urlsFromArray.length;
    return urlsFromArray
      .map((value, index) => ({
        path: undefined,
        url: value?.trim() || undefined,
        mime: resolveMime(count, index),
        index,
      }))
      .filter((entry) => Boolean(entry.url?.trim()));
  }

  const pathValue = ctx.MediaPath?.trim();
  const url = ctx.MediaUrl?.trim();
  if (!pathValue && !url) return [];
  return [
    {
      path: pathValue || undefined,
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

function isImageAttachment(attachment: MediaAttachment): boolean {
  if (attachment.mime?.startsWith("image/")) return true;
  const ext = getFileExtension(attachment.path ?? attachment.url);
  if (!ext) return false;
  return [".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tiff", ".tif"].includes(ext);
}

function estimateBase64Size(bytes: number): number {
  return Math.ceil(bytes / 3) * 4;
}

function resolveVideoMaxBase64Bytes(maxBytes: number): number {
  const expanded = Math.floor(maxBytes * (4 / 3));
  return Math.min(expanded, DEFAULT_VIDEO_MAX_BASE64_BYTES);
}

function resolveTimeoutMs(seconds: number | undefined, fallbackSeconds: number): number {
  const value = typeof seconds === "number" && Number.isFinite(seconds) ? seconds : fallbackSeconds;
  return Math.max(1000, Math.floor(value * 1000));
}

function resolvePrompt(capability: Capability, prompt?: string, maxChars?: number): string {
  const base = prompt?.trim() || DEFAULT_PROMPT[capability];
  if (!maxChars || capability === "audio") return base;
  return `${base} Respond in at most ${maxChars} characters.`;
}

function resolveRequestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function normalizeErrorMessage(err: unknown): string {
  if (!err) return "";
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  try {
    return JSON.stringify(err);
  } catch {
    return "";
  }
}

function resolveMaxChars(params: {
  capability: Capability;
  entry: MediaUnderstandingModelConfig;
  cfg: ClawdbotConfig;
}): number | undefined {
  const { capability, entry, cfg } = params;
  const configured = entry.maxChars ?? cfg.tools?.media?.[capability]?.maxChars;
  if (typeof configured === "number") return configured;
  return DEFAULT_MAX_CHARS_BY_CAPABILITY[capability];
}

function trimOutput(text: string, maxChars?: number): string {
  const trimmed = text.trim();
  if (!maxChars || trimmed.length <= maxChars) return trimmed;
  return trimmed.slice(0, maxChars).trim();
}

function resolveConfigValue<T>(primary: T | undefined, fallback: T): T {
  return primary === undefined ? fallback : primary;
}

function resolveCapabilityConfig(
  cfg: ClawdbotConfig,
  capability: Capability,
): MediaUnderstandingConfig | undefined {
  return cfg.tools?.media?.[capability];
}

function resolveScopeDecision(params: {
  scope?: MediaUnderstandingScopeConfig;
  ctx: MsgContext;
}): "allow" | "deny" {
  return resolveMediaUnderstandingScope({
    scope: params.scope,
    sessionKey: params.ctx.SessionKey,
    channel: params.ctx.Surface ?? params.ctx.Provider,
    chatType: normalizeMediaUnderstandingChatType(params.ctx.ChatType),
  });
}

function resolveModelEntries(
  cfg: MediaUnderstandingConfig | undefined,
  capability: Capability,
): MediaUnderstandingModelConfig[] {
  const models = cfg?.models ?? [];
  if (models.length === 0) return [];
  return models.filter((entry) => {
    const caps = entry.capabilities;
    if (!caps || caps.length === 0) return true;
    return caps.includes(capability);
  });
}

function isMaxBytesError(err: unknown): boolean {
  const message = normalizeErrorMessage(err);
  if (!message) return false;
  return message.includes("exceeds maxBytes") || message.includes("payload exceeds maxBytes");
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
    }
  }

  const url = attachment.url?.trim();
  if (!url) return undefined;

  try {
    const fetchImpl = (input: RequestInfo | URL, init?: RequestInit) =>
      fetchWithTimeout(resolveRequestUrl(input), init ?? {}, timeoutMs, fetch);
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
  }

  return undefined;
}

async function resolveAttachmentPath(params: {
  attachment: MediaAttachment;
  maxBytes?: number;
  timeoutMs: number;
}): Promise<MediaPathResult | undefined> {
  const { attachment, maxBytes, timeoutMs } = params;
  const rawPath = normalizeAttachmentPath(attachment.path);
  if (rawPath) {
    const resolved = path.isAbsolute(rawPath) ? rawPath : path.resolve(rawPath);
    try {
      const stat = await fs.stat(resolved);
      if (!stat.isFile()) return undefined;
      if (maxBytes && stat.size > maxBytes) {
        if (shouldLogVerbose()) {
          logVerbose(
            `Skipping media attachment ${attachment.index + 1}: ${stat.size} bytes exceeds ${maxBytes}`,
          );
        }
        return undefined;
      }
      return { path: resolved };
    } catch (err) {
      if (shouldLogVerbose()) {
        logVerbose(`Failed to read attachment ${attachment.index + 1}: ${String(err)}`);
      }
    }
  }

  const url = attachment.url?.trim();
  if (!url) return undefined;

  try {
    const fetchImpl = (input: RequestInfo | URL, init?: RequestInit) =>
      fetchWithTimeout(resolveRequestUrl(input), init ?? {}, timeoutMs, fetch);
    const fetched = await fetchRemoteMedia({ url, fetchImpl, maxBytes });
    const buffer = fetched.buffer;
    if (maxBytes && buffer.length > maxBytes) {
      if (shouldLogVerbose()) {
        logVerbose(
          `Skipping media attachment ${attachment.index + 1}: ${buffer.length} bytes exceeds ${maxBytes}`,
        );
      }
      return undefined;
    }
    const extension = fetched.fileName ? path.extname(fetched.fileName) : "";
    const tmpPath = path.join(
      os.tmpdir(),
      `clawdbot-media-${crypto.randomUUID()}${extension || ""}`,
    );
    await fs.writeFile(tmpPath, buffer);
    return {
      path: tmpPath,
      cleanup: async () => {
        await fs.unlink(tmpPath).catch(() => {});
      },
    };
  } catch (err) {
    if (shouldLogVerbose()) {
      logVerbose(`Failed to fetch attachment ${attachment.index + 1}: ${String(err)}`);
    }
  }

  return undefined;
}

async function describeImageWithModel(params: {
  cfg: ClawdbotConfig;
  agentDir: string;
  provider: string;
  model: string;
  prompt: string;
  maxChars?: number;
  buffer: Buffer;
  mimeType: string;
  profile?: string;
  preferredProfile?: string;
}): Promise<{ text: string; model: string }> {
  await ensureClawdbotModelsJson(params.cfg, params.agentDir);
  const authStorage = discoverAuthStorage(params.agentDir);
  const modelRegistry = discoverModels(authStorage, params.agentDir);
  const model = modelRegistry.find(params.provider, params.model) as Model<Api> | null;
  if (!model) {
    throw new Error(`Unknown model: ${params.provider}/${params.model}`);
  }
  if (!model.input?.includes("image")) {
    throw new Error(`Model does not support images: ${params.provider}/${params.model}`);
  }
  const apiKeyInfo = await getApiKeyForModel({
    model,
    cfg: params.cfg,
    agentDir: params.agentDir,
    profileId: params.profile,
    preferredProfile: params.preferredProfile,
  });
  authStorage.setRuntimeApiKey(model.provider, apiKeyInfo.apiKey);

  const base64 = params.buffer.toString("base64");
  if (model.provider === "minimax") {
    const text = await minimaxUnderstandImage({
      apiKey: apiKeyInfo.apiKey,
      prompt: params.prompt,
      imageDataUrl: `data:${params.mimeType};base64,${base64}`,
      modelBaseUrl: model.baseUrl,
    });
    return { text, model: model.id };
  }

  const context: Context = {
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: params.prompt },
          { type: "image", data: base64, mimeType: params.mimeType },
        ],
        timestamp: Date.now(),
      },
    ],
  };
  const message = (await complete(model, context, {
    apiKey: apiKeyInfo.apiKey,
    maxTokens: 512,
  })) as AssistantMessage;
  const text = coerceImageAssistantText({
    message,
    provider: model.provider,
    model: model.id,
  });
  return { text, model: model.id };
}

async function runProviderEntry(params: {
  capability: Capability;
  entry: MediaUnderstandingModelConfig;
  cfg: ClawdbotConfig;
  ctx: MsgContext;
  attachment: MediaAttachment;
  agentDir?: string;
  providerRegistry: Map<string, MediaUnderstandingProvider>;
}): Promise<MediaUnderstandingOutput | null> {
  const { entry, capability, cfg, attachment } = params;
  const providerIdRaw = entry.provider?.trim();
  if (!providerIdRaw) {
    throw new Error(`Provider entry missing provider for ${capability}`);
  }
  const providerId = normalizeMediaProviderId(providerIdRaw);
  const maxBytes = entry.maxBytes ?? resolveConfigValue(cfg.tools?.media?.[capability]?.maxBytes, DEFAULT_MAX_BYTES[capability]);
  const maxChars = resolveMaxChars({ capability, entry, cfg });
  const timeoutMs = resolveTimeoutMs(
    entry.timeoutSeconds ?? cfg.tools?.media?.[capability]?.timeoutSeconds,
    DEFAULT_TIMEOUT_SECONDS[capability],
  );
  const prompt = resolvePrompt(
    capability,
    entry.prompt ?? cfg.tools?.media?.[capability]?.prompt,
    maxChars,
  );

  if (capability === "image") {
    if (!params.agentDir) {
      throw new Error("Image understanding requires agentDir");
    }
    const modelId = entry.model?.trim();
    if (!modelId) {
      throw new Error("Image understanding requires model id");
    }
    const media = await loadAttachmentBuffer({ attachment, maxBytes, timeoutMs });
    if (!media) return null;
    const mimeType = media.mime ?? "image/jpeg";
    const result = await describeImageWithModel({
      cfg,
      agentDir: params.agentDir,
      provider: providerId,
      model: modelId,
      prompt,
      maxChars,
      buffer: media.buffer,
      mimeType,
      profile: entry.profile,
      preferredProfile: entry.preferredProfile,
    });
    return {
      kind: "image.description",
      attachmentIndex: attachment.index,
      text: trimOutput(result.text, maxChars),
      provider: providerId,
      model: result.model,
    };
  }

  const provider = getMediaUnderstandingProvider(providerId, params.providerRegistry);
  if (!provider) {
    throw new Error(`Media provider not available: ${providerId}`);
  }

  if (capability === "audio") {
    if (!provider.transcribeAudio) {
      throw new Error(`Audio transcription provider "${providerId}" not available.`);
    }
    const media = await loadAttachmentBuffer({ attachment, maxBytes, timeoutMs });
    if (!media) return null;
    const key = await resolveApiKeyForProvider({
      provider: providerId,
      cfg,
      profileId: entry.profile,
      preferredProfile: entry.preferredProfile,
      agentDir: params.agentDir,
    });
    const providerConfig = cfg.models?.providers?.[providerId];
    const model = entry.model?.trim() || DEFAULT_AUDIO_MODELS[providerId] || entry.model;
    const result = await provider.transcribeAudio({
      buffer: media.buffer,
      fileName: media.fileName,
      mime: media.mime,
      apiKey: key.apiKey,
      baseUrl: providerConfig?.baseUrl,
      headers: providerConfig?.headers,
      model,
      language: entry.language ?? cfg.tools?.media?.audio?.language,
      prompt,
      timeoutMs,
    });
    return {
      kind: "audio.transcription",
      attachmentIndex: attachment.index,
      text: trimOutput(result.text, maxChars),
      provider: providerId,
      model: result.model ?? model,
    };
  }

  if (capability === "video") {
    if (!provider.describeVideo) {
      throw new Error(`Video understanding provider "${providerId}" not available.`);
    }
    const media = await loadAttachmentBuffer({ attachment, maxBytes, timeoutMs });
    if (!media) return null;
    const estimatedBase64Bytes = estimateBase64Size(media.buffer.length);
    const maxBase64Bytes = resolveVideoMaxBase64Bytes(maxBytes);
    if (estimatedBase64Bytes > maxBase64Bytes) {
      if (shouldLogVerbose()) {
        logVerbose(
          `Skipping video attachment ${attachment.index + 1}: base64 payload ${estimatedBase64Bytes} exceeds ${maxBase64Bytes}`,
        );
      }
      return null;
    }
    const key = await resolveApiKeyForProvider({
      provider: providerId,
      cfg,
      profileId: entry.profile,
      preferredProfile: entry.preferredProfile,
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
      model: entry.model,
      prompt,
      timeoutMs,
    });
    return {
      kind: "video.description",
      attachmentIndex: attachment.index,
      text: trimOutput(result.text, maxChars),
      provider: providerId,
      model: result.model ?? entry.model,
    };
  }

  return null;
}

async function runCliEntry(params: {
  capability: Capability;
  entry: MediaUnderstandingModelConfig;
  cfg: ClawdbotConfig;
  ctx: MsgContext;
  attachment: MediaAttachment;
}): Promise<MediaUnderstandingOutput | null> {
  const { entry, capability, cfg, ctx, attachment } = params;
  const command = entry.command?.trim();
  const args = entry.args ?? [];
  if (!command) {
    throw new Error(`CLI entry missing command for ${capability}`);
  }
  const maxBytes = entry.maxBytes ?? resolveConfigValue(cfg.tools?.media?.[capability]?.maxBytes, DEFAULT_MAX_BYTES[capability]);
  const maxChars = resolveMaxChars({ capability, entry, cfg });
  const timeoutMs = resolveTimeoutMs(
    entry.timeoutSeconds ?? cfg.tools?.media?.[capability]?.timeoutSeconds,
    DEFAULT_TIMEOUT_SECONDS[capability],
  );
  const prompt = resolvePrompt(
    capability,
    entry.prompt ?? cfg.tools?.media?.[capability]?.prompt,
    maxChars,
  );
  const pathResult = await resolveAttachmentPath({
    attachment,
    maxBytes,
    timeoutMs,
  });
  if (!pathResult) return null;

  const templCtx: MsgContext = {
    ...ctx,
    MediaPath: pathResult.path,
    Prompt: prompt,
    MaxChars: maxChars,
  };
  const argv = [command, ...args].map((part, index) =>
    index === 0 ? part : applyTemplate(part, templCtx),
  );
  if (shouldLogVerbose()) {
    logVerbose(`Media understanding via CLI: ${argv.join(" ")}`);
  }
  try {
    const { stdout } = await runExec(argv[0], argv.slice(1), {
      timeoutMs,
      maxBuffer: CLI_OUTPUT_MAX_BUFFER,
    });
    const text = trimOutput(stdout, maxChars);
    if (!text) return null;
    return {
      kind: capability === "audio" ? "audio.transcription" : `${capability}.description`,
      attachmentIndex: attachment.index,
      text,
      provider: "cli",
      model: command,
    };
  } finally {
    if (pathResult.cleanup) {
      await pathResult.cleanup();
    }
  }
}

async function runCapability(params: {
  capability: Capability;
  cfg: ClawdbotConfig;
  ctx: MsgContext;
  attachments: MediaAttachment[];
  agentDir?: string;
  providerRegistry: Map<string, MediaUnderstandingProvider>;
}): Promise<MediaUnderstandingOutput | null> {
  const { capability, cfg, ctx, attachments } = params;
  const config = resolveCapabilityConfig(cfg, capability);
  if (!config || config.enabled === false) return null;
  const entries = resolveModelEntries(config, capability);
  if (entries.length === 0) return null;

  const scopeDecision = resolveScopeDecision({ scope: config.scope, ctx });
  if (scopeDecision === "deny") {
    if (shouldLogVerbose()) {
      logVerbose(`${capability} understanding disabled by scope policy.`);
    }
    return null;
  }

  const attachment = attachments.find((item) => {
    if (capability === "image") return isImageAttachment(item);
    if (capability === "audio") return isAudioAttachment(item);
    return isVideoAttachment(item);
  });
  if (!attachment) return null;

  for (const entry of entries) {
    try {
      const entryType = entry.type ?? (entry.command ? "cli" : "provider");
      const result =
        entryType === "cli"
          ? await runCliEntry({ capability, entry, cfg, ctx, attachment })
          : await runProviderEntry({
              capability,
              entry,
              cfg,
              ctx,
              attachment,
              agentDir: params.agentDir,
              providerRegistry: params.providerRegistry,
            });
      if (result) return result;
    } catch (err) {
      if (isMaxBytesError(err)) {
        if (shouldLogVerbose()) {
          logVerbose(`Skipping ${capability} model due to size: ${String(err)}`);
        }
      } else if (shouldLogVerbose()) {
        logVerbose(`${capability} understanding failed: ${String(err)}`);
      }
    }
  }

  return null;
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

  const attachments = normalizeAttachments(ctx);
  const providerRegistry = buildMediaUnderstandingRegistry(params.providers);
  const outputs: MediaUnderstandingOutput[] = [];

  const imageOutput = await runCapability({
    capability: "image",
    cfg,
    ctx,
    attachments,
    agentDir: params.agentDir,
    providerRegistry,
  });
  if (imageOutput) outputs.push(imageOutput);

  const audioOutput = await runCapability({
    capability: "audio",
    cfg,
    ctx,
    attachments,
    agentDir: params.agentDir,
    providerRegistry,
  });
  if (audioOutput) outputs.push(audioOutput);

  const videoOutput = await runCapability({
    capability: "video",
    cfg,
    ctx,
    attachments,
    agentDir: params.agentDir,
    providerRegistry,
  });
  if (videoOutput) outputs.push(videoOutput);

  if (outputs.length > 0) {
    ctx.Body = formatMediaUnderstandingBody({ body: ctx.Body, outputs });
    const audioResult = outputs.find((output) => output.kind === "audio.transcription");
    if (audioResult) {
      ctx.Transcript = audioResult.text;
      ctx.CommandBody = audioResult.text;
      ctx.RawBody = audioResult.text;
    } else if (originalUserText) {
      ctx.CommandBody = originalUserText;
      ctx.RawBody = originalUserText;
    }
    ctx.MediaUnderstanding = [...(ctx.MediaUnderstanding ?? []), ...outputs];
  }

  return {
    outputs,
    appliedImage: outputs.some((output) => output.kind === "image.description"),
    appliedAudio: outputs.some((output) => output.kind === "audio.transcription"),
    appliedVideo: outputs.some((output) => output.kind === "video.description"),
  };
}

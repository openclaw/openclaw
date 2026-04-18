import { randomUUID } from "node:crypto";
import { unlink, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join as pathJoin } from "node:path";
import type { ImageContent } from "../agents/command/types.js";
import { normalizeUsage, toOpenAiChatCompletionsUsage } from "../agents/usage.js";
import { createDefaultDeps } from "../cli/deps.js";
import { agentCommandFromIngress } from "../commands/agent.js";
import { loadConfig } from "../config/io.js";
import type { GatewayHttpChatCompletionsConfig } from "../config/types.gateway.js";
import { emitAgentEvent, onAgentEvent } from "../infra/agent-events.js";
import { logWarn } from "../logger.js";
import { transcribeFirstAudio } from "../media-understanding/audio-preflight.js";
import { canonicalizeBase64, estimateBase64DecodedBytes } from "../media/base64.js";
import { renderFileContextBlock } from "../media/file-context.js";
import {
  DEFAULT_INPUT_IMAGE_MAX_BYTES,
  DEFAULT_INPUT_IMAGE_MIMES,
  DEFAULT_INPUT_MAX_REDIRECTS,
  DEFAULT_INPUT_TIMEOUT_MS,
  extractFileContentFromSource,
  extractImageContentFromSource,
  normalizeMimeList,
  resolveInputFileLimits,
  type InputFileLimits,
  type InputImageLimits,
  type InputImageSource,
} from "../media/input-files.js";
import { mimeTypeFromFilePath } from "../media/mime.js";
import { defaultRuntime } from "../runtime.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "../shared/string-coerce.js";
import { resolveAssistantStreamDeltaText } from "./agent-event-assistant-text.js";
import {
  buildAgentMessageFromConversationEntries,
  type ConversationEntry,
} from "./agent-prompt.js";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import { sendJson, setSseHeaders, watchClientDisconnect, writeDone } from "./http-common.js";
import { handleGatewayPostJsonEndpoint } from "./http-endpoint-helpers.js";
import {
  resolveGatewayRequestContext,
  resolveOpenAiCompatModelOverride,
  resolveOpenAiCompatibleHttpOperatorScopes,
  resolveOpenAiCompatibleHttpSenderIsOwner,
} from "./http-utils.js";
import { normalizeInputHostnameAllowlist } from "./input-allowlist.js";
import { wrapUntrustedFileContent } from "./openresponses-file-content.js";

type OpenAiHttpOptions = {
  auth: ResolvedGatewayAuth;
  config?: GatewayHttpChatCompletionsConfig;
  maxBodyBytes?: number;
  trustedProxies?: string[];
  allowRealIpFallback?: boolean;
  rateLimiter?: AuthRateLimiter;
};

type OpenAiChatMessage = {
  role?: unknown;
  content?: unknown;
  name?: unknown;
};

type OpenAiChatCompletionRequest = {
  model?: unknown;
  stream?: unknown;
  // Naming/style reference: src/agents/openai-transport-stream.ts:1262-1273
  stream_options?: unknown;
  messages?: unknown;
  user?: unknown;
};

const DEFAULT_OPENAI_CHAT_COMPLETIONS_BODY_BYTES = 20 * 1024 * 1024;
const DEFAULT_OPENAI_MAX_IMAGE_PARTS = 8;
const DEFAULT_OPENAI_MAX_TOTAL_IMAGE_BYTES = 20 * 1024 * 1024;
const DEFAULT_OPENAI_MAX_AUDIO_PARTS = 4;
const DEFAULT_OPENAI_MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const DEFAULT_OPENAI_MAX_TOTAL_AUDIO_BYTES = 50 * 1024 * 1024;
const DEFAULT_OPENAI_AUDIO_MIMES = [
  "audio/wav",
  "audio/x-wav",
  "audio/mpeg",
  "audio/mp3",
  "audio/ogg",
  "audio/oga",
  "audio/webm",
  "audio/m4a",
  "audio/mp4",
  "audio/flac",
];
const DEFAULT_OPENAI_MAX_FILE_PARTS = 5;
const DEFAULT_OPENAI_MAX_FILE_BYTES = 20 * 1024 * 1024;
const DEFAULT_OPENAI_MAX_TOTAL_FILE_BYTES = 50 * 1024 * 1024;
const DEFAULT_OPENAI_IMAGE_LIMITS: InputImageLimits = {
  allowUrl: false,
  allowedMimes: new Set(DEFAULT_INPUT_IMAGE_MIMES),
  maxBytes: DEFAULT_INPUT_IMAGE_MAX_BYTES,
  maxRedirects: DEFAULT_INPUT_MAX_REDIRECTS,
  timeoutMs: DEFAULT_INPUT_TIMEOUT_MS,
};

type ResolvedAudioLimits = {
  enabled: boolean;
  maxParts: number;
  maxBytes: number;
  maxTotalBytes: number;
  allowedMimes: Set<string>;
};

type ResolvedFileLimits = InputFileLimits & {
  enabled: boolean;
  maxParts: number;
  maxTotalBytes: number;
};

type ResolvedOpenAiChatCompletionsLimits = {
  maxBodyBytes: number;
  maxImageParts: number;
  maxTotalImageBytes: number;
  images: InputImageLimits;
  audio: ResolvedAudioLimits;
  files: ResolvedFileLimits;
};

function resolveOpenAiChatCompletionsLimits(
  config: GatewayHttpChatCompletionsConfig | undefined,
): ResolvedOpenAiChatCompletionsLimits {
  const imageConfig = config?.images;
  const audioConfig = config?.audio;
  const fileConfig = config?.files;
  const fileLimits = resolveInputFileLimits({
    ...fileConfig,
    maxBytes: fileConfig?.maxBytes ?? DEFAULT_OPENAI_MAX_FILE_BYTES,
  });
  return {
    maxBodyBytes: config?.maxBodyBytes ?? DEFAULT_OPENAI_CHAT_COMPLETIONS_BODY_BYTES,
    maxImageParts:
      typeof config?.maxImageParts === "number"
        ? Math.max(0, Math.floor(config.maxImageParts))
        : DEFAULT_OPENAI_MAX_IMAGE_PARTS,
    maxTotalImageBytes:
      typeof config?.maxTotalImageBytes === "number"
        ? Math.max(1, Math.floor(config.maxTotalImageBytes))
        : DEFAULT_OPENAI_MAX_TOTAL_IMAGE_BYTES,
    images: {
      allowUrl: imageConfig?.allowUrl ?? DEFAULT_OPENAI_IMAGE_LIMITS.allowUrl,
      urlAllowlist: normalizeInputHostnameAllowlist(imageConfig?.urlAllowlist),
      allowedMimes: normalizeMimeList(imageConfig?.allowedMimes, DEFAULT_INPUT_IMAGE_MIMES),
      maxBytes: imageConfig?.maxBytes ?? DEFAULT_INPUT_IMAGE_MAX_BYTES,
      maxRedirects: imageConfig?.maxRedirects ?? DEFAULT_INPUT_MAX_REDIRECTS,
      timeoutMs: imageConfig?.timeoutMs ?? DEFAULT_INPUT_TIMEOUT_MS,
    },
    audio: {
      enabled: audioConfig?.enabled !== false,
      maxParts:
        typeof audioConfig?.maxParts === "number"
          ? Math.max(0, Math.floor(audioConfig.maxParts))
          : DEFAULT_OPENAI_MAX_AUDIO_PARTS,
      maxBytes: audioConfig?.maxBytes ?? DEFAULT_OPENAI_MAX_AUDIO_BYTES,
      maxTotalBytes: audioConfig?.maxTotalBytes ?? DEFAULT_OPENAI_MAX_TOTAL_AUDIO_BYTES,
      allowedMimes: normalizeMimeList(audioConfig?.allowedMimes, DEFAULT_OPENAI_AUDIO_MIMES),
    },
    files: {
      enabled: fileConfig?.enabled !== false,
      ...fileLimits,
      maxParts:
        typeof fileConfig?.maxParts === "number"
          ? Math.max(0, Math.floor(fileConfig.maxParts))
          : DEFAULT_OPENAI_MAX_FILE_PARTS,
      maxTotalBytes: fileConfig?.maxTotalBytes ?? DEFAULT_OPENAI_MAX_TOTAL_FILE_BYTES,
    },
  };
}

function writeSse(res: ServerResponse, data: unknown) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function buildAgentCommandInput(params: {
  prompt: { message: string; extraSystemPrompt?: string; images?: ImageContent[] };
  modelOverride?: string;
  sessionKey: string;
  runId: string;
  messageChannel: string;
  senderIsOwner: boolean;
  abortSignal?: AbortSignal;
}) {
  return {
    message: params.prompt.message,
    extraSystemPrompt: params.prompt.extraSystemPrompt,
    images: params.prompt.images,
    model: params.modelOverride,
    sessionKey: params.sessionKey,
    runId: params.runId,
    deliver: false as const,
    messageChannel: params.messageChannel,
    bestEffortDeliver: false as const,
    senderIsOwner: params.senderIsOwner,
    allowModelOverride: true as const,
    abortSignal: params.abortSignal,
  };
}

function writeAssistantRoleChunk(res: ServerResponse, params: { runId: string; model: string }) {
  writeSse(res, {
    id: params.runId,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: params.model,
    choices: [{ index: 0, delta: { role: "assistant" } }],
  });
}

function writeAssistantContentChunk(
  res: ServerResponse,
  params: { runId: string; model: string; content: string; finishReason: "stop" | null },
) {
  writeSse(res, {
    id: params.runId,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: params.model,
    choices: [
      {
        index: 0,
        delta: { content: params.content },
        finish_reason: params.finishReason,
      },
    ],
  });
}

function writeAssistantStopChunk(res: ServerResponse, params: { runId: string; model: string }) {
  writeSse(res, {
    id: params.runId,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: params.model,
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: "stop",
      },
    ],
  });
}

function writeUsageChunk(
  res: ServerResponse,
  params: {
    runId: string;
    model: string;
    usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  },
) {
  writeSse(res, {
    id: params.runId,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: params.model,
    choices: [],
    usage: params.usage,
  });
}

function asMessages(val: unknown): OpenAiChatMessage[] {
  return Array.isArray(val) ? (val as OpenAiChatMessage[]) : [];
}

function extractTextContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (!part || typeof part !== "object") {
          return "";
        }
        const type = (part as { type?: unknown }).type;
        const text = (part as { text?: unknown }).text;
        const inputText = (part as { input_text?: unknown }).input_text;
        if (type === "text" && typeof text === "string") {
          return text;
        }
        if (type === "input_text" && typeof text === "string") {
          return text;
        }
        if (typeof inputText === "string") {
          return inputText;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function resolveImageUrlPart(part: unknown): string | undefined {
  if (!part || typeof part !== "object") {
    return undefined;
  }
  const imageUrl = (part as { image_url?: unknown }).image_url;
  if (typeof imageUrl === "string") {
    const trimmed = imageUrl.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (!imageUrl || typeof imageUrl !== "object") {
    return undefined;
  }
  const rawUrl = (imageUrl as { url?: unknown }).url;
  if (typeof rawUrl !== "string") {
    return undefined;
  }
  const trimmed = rawUrl.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function extractImageUrls(content: unknown): string[] {
  if (!Array.isArray(content)) {
    return [];
  }
  const urls: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") {
      continue;
    }
    if ((part as { type?: unknown }).type !== "image_url") {
      continue;
    }
    const url = resolveImageUrlPart(part);
    if (url) {
      urls.push(url);
    }
  }
  return urls;
}

type ParsedAudioPart = { data: string; mime: string };
type ParsedFilePart = { data: string; mediaType?: string; filename: string };

function resolveInputAudioPart(part: unknown): ParsedAudioPart | undefined {
  if (!part || typeof part !== "object") {
    return undefined;
  }
  const inputAudio = (part as { input_audio?: unknown }).input_audio;
  if (!inputAudio || typeof inputAudio !== "object") {
    return undefined;
  }
  const rawData = (inputAudio as { data?: unknown }).data;
  const data = typeof rawData === "string" ? rawData.trim() : "";
  if (!data) {
    return undefined;
  }
  const rawFormat = (inputAudio as { format?: unknown }).format;
  const format = typeof rawFormat === "string" ? rawFormat.trim().toLowerCase() : "";
  const mime = format ? (format.includes("/") ? format : `audio/${format}`) : "audio/wav";
  return { data, mime };
}

function extractAudioParts(content: unknown): ParsedAudioPart[] {
  if (!Array.isArray(content)) {
    return [];
  }
  const out: ParsedAudioPart[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") {
      continue;
    }
    if ((part as { type?: unknown }).type !== "input_audio") {
      continue;
    }
    const resolved = resolveInputAudioPart(part);
    if (resolved) {
      out.push(resolved);
    }
  }
  return out;
}

function resolveFilePart(part: unknown): ParsedFilePart | undefined {
  if (!part || typeof part !== "object") {
    return undefined;
  }
  const file = (part as { file?: unknown }).file;
  if (!file || typeof file !== "object") {
    return undefined;
  }
  const rawData = (file as { file_data?: unknown }).file_data;
  const rawDataStr = typeof rawData === "string" ? rawData.trim() : "";
  if (!rawDataStr) {
    return undefined;
  }
  const filenameRaw = (file as { filename?: unknown }).filename;
  const filename = typeof filenameRaw === "string" && filenameRaw.length > 0 ? filenameRaw : "file";
  const mimeRaw = (file as { mime_type?: unknown }).mime_type;
  let mediaType = typeof mimeRaw === "string" ? mimeRaw : undefined;
  let base64Data = rawDataStr;
  const dataUriMatch = /^data:([^,]*?),(.*)$/is.exec(rawDataStr);
  if (dataUriMatch) {
    const metadata = normalizeOptionalString(dataUriMatch[1]) ?? "";
    base64Data = dataUriMatch[2] ?? "";
    const metadataParts = metadata
      .split(";")
      .map((p) => normalizeOptionalString(p) ?? "")
      .filter(Boolean);
    const isBase64 = metadataParts.some((p) => normalizeLowercaseStringOrEmpty(p) === "base64");
    if (!isBase64) {
      throw new Error("file file_data data URI must be base64 encoded");
    }
    if (!mediaType) {
      mediaType = metadataParts.find((p) => p.includes("/"));
    }
  }
  if (!base64Data) {
    throw new Error("file file_data missing payload");
  }
  // OpenAI-compat clients commonly send `file_data` + `filename` with no
  // explicit `mime_type` (and no `data:<mime>;base64,` envelope). Rather than
  // hard-failing downstream with "input_file missing media type", infer from
  // the filename extension when we can. Downstream allowedMimes enforcement
  // (input-files.ts:371) still rejects unsupported types with a clear 400.
  if (!mediaType) {
    const inferred = mimeTypeFromFilePath(filename);
    if (inferred) {
      mediaType = inferred;
    }
  }
  return { data: base64Data, mediaType, filename };
}

function extractFileParts(content: unknown): ParsedFilePart[] {
  if (!Array.isArray(content)) {
    return [];
  }
  const out: ParsedFilePart[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") {
      continue;
    }
    if ((part as { type?: unknown }).type !== "file") {
      continue;
    }
    const resolved = resolveFilePart(part);
    if (resolved) {
      out.push(resolved);
    }
  }
  return out;
}

function hasVideoUrlPart(content: unknown): boolean {
  if (!Array.isArray(content)) {
    return false;
  }
  for (const part of content) {
    if (!part || typeof part !== "object") {
      continue;
    }
    if ((part as { type?: unknown }).type === "video_url") {
      return true;
    }
  }
  return false;
}

type ActiveTurnContext = {
  activeTurnIndex: number;
  activeUserMessageIndex: number;
  urls: string[];
  audioParts: ParsedAudioPart[];
  fileParts: ParsedFilePart[];
  hasVideoUrl: boolean;
};

function parseImageUrlToSource(url: string): InputImageSource {
  const dataUriMatch = /^data:([^,]*?),(.*)$/is.exec(url);
  if (dataUriMatch) {
    const metadata = normalizeOptionalString(dataUriMatch[1]) ?? "";
    const data = dataUriMatch[2] ?? "";
    const metadataParts = metadata
      .split(";")
      .map((part) => normalizeOptionalString(part) ?? "")
      .filter(Boolean);
    const isBase64 = metadataParts.some(
      (part) => normalizeLowercaseStringOrEmpty(part) === "base64",
    );
    if (!isBase64) {
      throw new Error("image_url data URI must be base64 encoded");
    }
    if (!(normalizeOptionalString(data) ?? "")) {
      throw new Error("image_url data URI is missing payload data");
    }
    const mediaTypeRaw = metadataParts.find((part) => part.includes("/"));
    return {
      type: "base64",
      mediaType: mediaTypeRaw,
      data,
    };
  }
  return { type: "url", url };
}

function resolveActiveTurnContext(messagesUnknown: unknown): ActiveTurnContext {
  const messages = asMessages(messagesUnknown);
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (!msg || typeof msg !== "object") {
      continue;
    }
    const role = normalizeOptionalString(msg.role) ?? "";
    const normalizedRole = role === "function" ? "tool" : role;
    if (normalizedRole !== "user" && normalizedRole !== "tool") {
      continue;
    }
    const isUser = normalizedRole === "user";
    return {
      activeTurnIndex: i,
      activeUserMessageIndex: isUser ? i : -1,
      urls: isUser ? extractImageUrls(msg.content) : [],
      audioParts: isUser ? extractAudioParts(msg.content) : [],
      fileParts: isUser ? extractFileParts(msg.content) : [],
      hasVideoUrl: isUser ? hasVideoUrlPart(msg.content) : false,
    };
  }
  return {
    activeTurnIndex: -1,
    activeUserMessageIndex: -1,
    urls: [],
    audioParts: [],
    fileParts: [],
    hasVideoUrl: false,
  };
}

async function resolveImagesForRequest(
  activeTurnContext: Pick<ActiveTurnContext, "urls">,
  limits: ResolvedOpenAiChatCompletionsLimits,
): Promise<ImageContent[]> {
  const urls = activeTurnContext.urls;
  if (urls.length === 0) {
    return [];
  }
  if (urls.length > limits.maxImageParts) {
    throw new Error(`Too many image_url parts (${urls.length}; limit ${limits.maxImageParts})`);
  }

  const images: ImageContent[] = [];
  let totalBytes = 0;
  for (const url of urls) {
    const source = parseImageUrlToSource(url);
    if (source.type === "base64") {
      const sourceBytes = estimateBase64DecodedBytes(source.data);
      if (totalBytes + sourceBytes > limits.maxTotalImageBytes) {
        throw new Error(
          `Total image payload too large (${totalBytes + sourceBytes}; limit ${limits.maxTotalImageBytes})`,
        );
      }
    }

    const image = await extractImageContentFromSource(source, limits.images);
    totalBytes += estimateBase64DecodedBytes(image.data);
    if (totalBytes > limits.maxTotalImageBytes) {
      throw new Error(
        `Total image payload too large (${totalBytes}; limit ${limits.maxTotalImageBytes})`,
      );
    }
    images.push(image);
  }
  return images;
}

async function resolveAudiosForRequest(
  activeTurnContext: Pick<ActiveTurnContext, "audioParts">,
  limits: ResolvedOpenAiChatCompletionsLimits,
): Promise<string[]> {
  const parts = activeTurnContext.audioParts;
  if (parts.length === 0) {
    return [];
  }
  if (parts.length > limits.audio.maxParts) {
    throw new Error(`Too many input_audio parts (${parts.length}; limit ${limits.audio.maxParts})`);
  }

  // Loading cfg is a sync snapshot lookup after first process load, so it's
  // cheap per-request and lets us reuse the Telegram/LINE STT pipeline via
  // transcribeFirstAudio (which dispatches to configured media providers).
  const cfg = loadConfig();
  const transcripts: string[] = [];
  let totalBytes = 0;

  for (const part of parts) {
    if (!limits.audio.allowedMimes.has(part.mime)) {
      throw new Error(`Unsupported audio MIME type: ${part.mime}`);
    }
    const sourceBytes = estimateBase64DecodedBytes(part.data);
    if (sourceBytes > limits.audio.maxBytes) {
      throw new Error(`Audio too large: ${sourceBytes} bytes (limit ${limits.audio.maxBytes})`);
    }
    totalBytes += sourceBytes;
    if (totalBytes > limits.audio.maxTotalBytes) {
      throw new Error(
        `Total audio payload too large (${totalBytes}; limit ${limits.audio.maxTotalBytes})`,
      );
    }

    // Node's base64 decoder is lenient and silently drops invalid characters,
    // so a malformed payload would stage an empty/truncated file and surface
    // as a confusing "no transcript" 200 response. Mirror the image/file paths
    // (media/input-files.ts:{280,335}) which gate Buffer.from("base64") behind
    // canonicalizeBase64; here we map the failure to an Error so the handler's
    // try/catch returns 400 invalid_request_error instead.
    const canonicalAudioData = canonicalizeBase64(part.data);
    if (!canonicalAudioData) {
      throw new Error("input_audio base64 source has invalid 'data' field");
    }

    // transcribeFirstAudio consumes attachments via MsgContext with file paths,
    // mirroring the Telegram/LINE voice preflight flow. We stage the decoded
    // audio to a tmp file so the STT runner can open it.
    const extGuess = part.mime.split("/")[1] ?? "wav";
    const safeExt = extGuess.replace(/[^a-z0-9]/gi, "") || "wav";
    const tmpPath = pathJoin(tmpdir(), `openclaw-audio-${randomUUID()}.${safeExt}`);
    await writeFile(tmpPath, Buffer.from(canonicalAudioData, "base64"));
    try {
      // transcribeFirstAudio expects a full MsgContext (channel id, sender,
      // timestamps, etc.), but its audio-preflight code path only reads
      // ctx.MediaPaths + ctx.MediaTypes. We synthesise the minimal shape here
      // rather than inventing fake channel metadata; the `as any` is scoped
      // to this single object literal.
      const transcript = await transcribeFirstAudio({
        ctx: {
          MediaPaths: [tmpPath],
          MediaTypes: [part.mime],
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
        cfg,
        agentDir: undefined,
      });
      if (transcript) {
        transcripts.push(transcript);
      }
    } finally {
      try {
        await unlink(tmpPath);
      } catch {
        /* best-effort cleanup */
      }
    }
  }

  return transcripts;
}

type FileResolutionResult = {
  contexts: string[];
  images: ImageContent[];
};

async function resolveFilesForRequest(
  activeTurnContext: Pick<ActiveTurnContext, "fileParts">,
  limits: ResolvedOpenAiChatCompletionsLimits,
): Promise<FileResolutionResult> {
  const parts = activeTurnContext.fileParts;
  if (parts.length === 0) {
    return { contexts: [], images: [] };
  }
  if (parts.length > limits.files.maxParts) {
    throw new Error(`Too many file parts (${parts.length}; limit ${limits.files.maxParts})`);
  }
  const contexts: string[] = [];
  const images: ImageContent[] = [];
  let totalBytes = 0;
  for (const part of parts) {
    const sourceBytes = estimateBase64DecodedBytes(part.data);
    if (sourceBytes > limits.files.maxBytes) {
      throw new Error(`File too large: ${sourceBytes} bytes (limit ${limits.files.maxBytes})`);
    }
    totalBytes += sourceBytes;
    if (totalBytes > limits.files.maxTotalBytes) {
      throw new Error(
        `Total file payload too large (${totalBytes}; limit ${limits.files.maxTotalBytes})`,
      );
    }
    const extracted = await extractFileContentFromSource({
      source: {
        type: "base64",
        data: part.data,
        mediaType: part.mediaType,
        filename: part.filename,
      },
      limits: limits.files,
    });
    const rawText = extracted.text;
    if (rawText?.trim()) {
      contexts.push(
        renderFileContextBlock({
          filename: extracted.filename,
          content: wrapUntrustedFileContent(rawText),
        }),
      );
    } else if (extracted.images && extracted.images.length > 0) {
      contexts.push(
        renderFileContextBlock({
          filename: extracted.filename,
          content: "[PDF content rendered to images]",
          surroundContentWithNewlines: false,
        }),
      );
    }
    if (extracted.images && extracted.images.length > 0) {
      images.push(...extracted.images);
    }
  }
  return { contexts, images };
}

export const __testOnlyOpenAiHttp = {
  resolveImagesForRequest,
  resolveAudiosForRequest,
  resolveFilesForRequest,
  resolveOpenAiChatCompletionsLimits,
  extractAudioParts,
  extractFileParts,
  hasVideoUrlPart,
  resolveActiveTurnContext,
  buildAgentPrompt,
};

/**
 * Synthesise a user-message placeholder for an active user turn that carries
 * only media (image/audio/file) with no accompanying text. Without this, a
 * text-less turn gets skipped entirely and the previous turn's text would
 * leak into the agent prompt as "current message" (stale-text bug); first
 * turns with no prior text would trip the "Missing user message" 400 gate.
 */
function buildActiveUserTurnPlaceholder(activeTurnContext: ActiveTurnContext): string {
  const parts: string[] = [];
  if (activeTurnContext.urls.length > 0) {
    parts.push(
      activeTurnContext.urls.length === 1 ? "1 image" : `${activeTurnContext.urls.length} images`,
    );
  }
  if (activeTurnContext.audioParts.length > 0) {
    parts.push(
      activeTurnContext.audioParts.length === 1
        ? "1 audio clip"
        : `${activeTurnContext.audioParts.length} audio clips`,
    );
  }
  if (activeTurnContext.fileParts.length > 0) {
    const names = activeTurnContext.fileParts
      .map((p) => p.filename.trim())
      .filter((name) => name.length > 0);
    if (names.length > 0) {
      parts.push(
        names.length === 1
          ? `file "${names[0]}"`
          : `files: ${names.map((n) => `"${n}"`).join(", ")}`,
      );
    } else {
      parts.push(
        activeTurnContext.fileParts.length === 1
          ? "1 file"
          : `${activeTurnContext.fileParts.length} files`,
      );
    }
  }
  if (parts.length === 0) {
    return "";
  }
  return `User attached ${parts.join(" + ")} with no accompanying text.`;
}

function buildAgentPrompt(
  messagesUnknown: unknown,
  activeTurnContext: ActiveTurnContext,
): {
  message: string;
  extraSystemPrompt?: string;
} {
  const messages = asMessages(messagesUnknown);

  const systemParts: string[] = [];
  const conversationEntries: ConversationEntry[] = [];

  for (const [i, msg] of messages.entries()) {
    if (!msg || typeof msg !== "object") {
      continue;
    }
    const role = normalizeOptionalString(msg.role) ?? "";
    const content = extractTextContent(msg.content).trim();
    if (!role) {
      continue;
    }
    if (role === "system" || role === "developer") {
      if (content) {
        systemParts.push(content);
      }
      continue;
    }

    const normalizedRole = role === "function" ? "tool" : role;
    if (normalizedRole !== "user" && normalizedRole !== "assistant" && normalizedRole !== "tool") {
      continue;
    }

    // For the active user turn, synthesise a placeholder when text is empty so
    // media-only turns (image/audio/file) still contribute a "current message"
    // entry. Historical media-only turns are intentionally skipped — their
    // bytes are not replayed, and mentioning them here would confuse the agent.
    const isActiveUserTurn =
      normalizedRole === "user" && i === activeTurnContext.activeUserMessageIndex;
    const messageContent =
      !content && isActiveUserTurn ? buildActiveUserTurnPlaceholder(activeTurnContext) : content;
    if (!messageContent) {
      continue;
    }

    const name = normalizeOptionalString(msg.name) ?? "";
    const sender =
      normalizedRole === "assistant"
        ? "Assistant"
        : normalizedRole === "user"
          ? "User"
          : name
            ? `Tool:${name}`
            : "Tool";

    conversationEntries.push({
      role: normalizedRole,
      entry: { sender, body: messageContent },
    });
  }

  const message = buildAgentMessageFromConversationEntries(conversationEntries);

  return {
    message,
    extraSystemPrompt: systemParts.length > 0 ? systemParts.join("\n\n") : undefined,
  };
}

function coerceRequest(val: unknown): OpenAiChatCompletionRequest {
  if (!val || typeof val !== "object") {
    return {};
  }
  return val as OpenAiChatCompletionRequest;
}

function resolveAgentResponseText(result: unknown): string {
  const payloads = (result as { payloads?: Array<{ text?: string }> } | null)?.payloads;
  if (!Array.isArray(payloads) || payloads.length === 0) {
    return "No response from OpenClaw.";
  }
  const content = payloads
    .map((p) => (typeof p.text === "string" ? p.text : ""))
    .filter(Boolean)
    .join("\n\n");
  return content || "No response from OpenClaw.";
}

type AgentUsageMeta = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  total?: number;
};

function resolveRawAgentUsage(result: unknown): AgentUsageMeta | undefined {
  return (
    result as {
      meta?: {
        agentMeta?: {
          usage?: AgentUsageMeta;
        };
      };
    } | null
  )?.meta?.agentMeta?.usage;
}

function resolveChatCompletionUsage(result: unknown): {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
} {
  return toOpenAiChatCompletionsUsage(normalizeUsage(resolveRawAgentUsage(result)));
}

function resolveIncludeUsageForStreaming(payload: OpenAiChatCompletionRequest): boolean {
  // Keep parsing aligned with OpenAI wire-format field names.
  // Flow reference: src/agents/openai-transport-stream.ts:1262-1273
  const streamOptions = payload.stream_options;
  if (!streamOptions || typeof streamOptions !== "object" || Array.isArray(streamOptions)) {
    return false;
  }
  return (streamOptions as { include_usage?: unknown }).include_usage === true;
}

export async function handleOpenAiHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: OpenAiHttpOptions,
): Promise<boolean> {
  const limits = resolveOpenAiChatCompletionsLimits(opts.config);
  const handled = await handleGatewayPostJsonEndpoint(req, res, {
    pathname: "/v1/chat/completions",
    requiredOperatorMethod: "chat.send",
    // Compat HTTP uses a different scope model from generic HTTP helpers:
    // shared-secret bearer auth is treated as full operator access here.
    resolveOperatorScopes: resolveOpenAiCompatibleHttpOperatorScopes,
    auth: opts.auth,
    trustedProxies: opts.trustedProxies,
    allowRealIpFallback: opts.allowRealIpFallback,
    rateLimiter: opts.rateLimiter,
    maxBodyBytes: opts.maxBodyBytes ?? limits.maxBodyBytes,
  });
  if (handled === false) {
    return false;
  }
  if (!handled) {
    return true;
  }
  // On the compat surface, shared-secret bearer auth is also treated as an
  // owner sender so owner-only tool policy matches the documented contract.
  const senderIsOwner = resolveOpenAiCompatibleHttpSenderIsOwner(req, handled.requestAuth);

  const payload = coerceRequest(handled.body);
  const stream = Boolean(payload.stream);
  const streamIncludeUsage = stream && resolveIncludeUsageForStreaming(payload);
  const model = typeof payload.model === "string" ? payload.model : "openclaw";
  const user = typeof payload.user === "string" ? payload.user : undefined;

  const { agentId, sessionKey, messageChannel } = resolveGatewayRequestContext({
    req,
    model,
    user,
    sessionPrefix: "openai",
    defaultMessageChannel: "webchat",
    useMessageChannelHeader: true,
  });
  const { modelOverride, errorMessage: modelError } = await resolveOpenAiCompatModelOverride({
    req,
    agentId,
    model,
  });
  if (modelError) {
    sendJson(res, 400, {
      error: { message: modelError, type: "invalid_request_error" },
    });
    return true;
  }
  // Parsing content blocks (file_data data URIs in particular) can throw on
  // malformed input. Catching here turns those errors into 400
  // invalid_request_error instead of bubbling up to the Node http server as
  // an unhandled exception that becomes a 500.
  let activeTurnContext: ActiveTurnContext;
  try {
    activeTurnContext = resolveActiveTurnContext(payload.messages);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logWarn(`openai-compat: invalid content block: ${detail}`);
    sendJson(res, 400, {
      error: {
        message: `Invalid content in \`messages\`: ${detail}`,
        type: "invalid_request_error",
      },
    });
    return true;
  }
  const prompt = buildAgentPrompt(payload.messages, activeTurnContext);
  let images: ImageContent[] = [];
  try {
    images = await resolveImagesForRequest(activeTurnContext, limits);
  } catch (err) {
    logWarn(`openai-compat: invalid image_url content: ${String(err)}`);
    sendJson(res, 400, {
      error: {
        message: "Invalid image_url content in `messages`.",
        type: "invalid_request_error",
      },
    });
    return true;
  }

  // Reject video_url content blocks explicitly. Providing text -> agent handoff
  // for video would require a keyframe extraction pipeline not yet wired into
  // the gateway. Being explicit prevents silent content drops.
  if (activeTurnContext.hasVideoUrl) {
    sendJson(res, 400, {
      error: {
        message:
          "video_url content blocks are not supported. Extract keyframes to image_url or transcribe externally.",
        type: "invalid_request_error",
      },
    });
    return true;
  }

  let audioTranscripts: string[] = [];
  if (limits.audio.enabled && activeTurnContext.audioParts.length > 0) {
    try {
      audioTranscripts = await resolveAudiosForRequest(activeTurnContext, limits);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      logWarn(`openai-compat: invalid input_audio content: ${detail}`);
      sendJson(res, 400, {
        error: {
          message: `Invalid input_audio content in \`messages\`: ${detail}`,
          type: "invalid_request_error",
        },
      });
      return true;
    }
  } else if (!limits.audio.enabled && activeTurnContext.audioParts.length > 0) {
    sendJson(res, 400, {
      error: {
        message: "input_audio content blocks are disabled on this gateway.",
        type: "invalid_request_error",
      },
    });
    return true;
  }

  let fileResolution: FileResolutionResult = { contexts: [], images: [] };
  if (limits.files.enabled && activeTurnContext.fileParts.length > 0) {
    try {
      fileResolution = await resolveFilesForRequest(activeTurnContext, limits);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      logWarn(`openai-compat: invalid file content: ${detail}`);
      sendJson(res, 400, {
        error: {
          message: `Invalid file content in \`messages\`: ${detail}`,
          type: "invalid_request_error",
        },
      });
      return true;
    }
  } else if (!limits.files.enabled && activeTurnContext.fileParts.length > 0) {
    sendJson(res, 400, {
      error: {
        message: "file content blocks are disabled on this gateway.",
        type: "invalid_request_error",
      },
    });
    return true;
  }

  // Audio transcripts are user-authored content (voice note → speech), so they
  // prepend to prompt.message. File contexts mirror /v1/responses behaviour by
  // attaching to extraSystemPrompt, which keeps untrusted file content clearly
  // scoped outside the user-authored turn.
  let finalMessage = prompt.message;
  if (audioTranscripts.length > 0) {
    const transcriptBlock = audioTranscripts
      .map((t, idx) =>
        audioTranscripts.length > 1
          ? `[Audio ${idx + 1} transcript]\n${t}`
          : `[Audio transcript]\n${t}`,
      )
      .join("\n\n");
    finalMessage = finalMessage ? `${transcriptBlock}\n\n${finalMessage}` : transcriptBlock;
  }

  const fileContext =
    fileResolution.contexts.length > 0 ? fileResolution.contexts.join("\n\n") : undefined;
  const extraSystemPrompt =
    [prompt.extraSystemPrompt, fileContext].filter(Boolean).join("\n\n") || undefined;
  const allImages =
    fileResolution.images.length > 0 ? images.concat(fileResolution.images) : images;

  if (!finalMessage && allImages.length === 0) {
    sendJson(res, 400, {
      error: {
        message: "Missing user message in `messages`.",
        type: "invalid_request_error",
      },
    });
    return true;
  }

  const runId = `chatcmpl_${randomUUID()}`;
  const deps = createDefaultDeps();
  const abortController = new AbortController();
  const commandInput = buildAgentCommandInput({
    prompt: {
      message: finalMessage,
      extraSystemPrompt,
      images: allImages.length > 0 ? allImages : undefined,
    },
    modelOverride,
    sessionKey,
    runId,
    messageChannel,
    abortSignal: abortController.signal,
    senderIsOwner,
  });

  if (!stream) {
    const stopWatchingDisconnect = watchClientDisconnect(req, res, abortController);
    try {
      const result = await agentCommandFromIngress(commandInput, defaultRuntime, deps);

      if (abortController.signal.aborted) {
        return true;
      }

      const content = resolveAgentResponseText(result);
      const usage = resolveChatCompletionUsage(result);

      sendJson(res, 200, {
        id: runId,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content },
            finish_reason: "stop",
          },
        ],
        usage,
      });
    } catch (err) {
      if (abortController.signal.aborted) {
        return true;
      }
      logWarn(`openai-compat: chat completion failed: ${String(err)}`);
      sendJson(res, 500, {
        error: { message: "internal error", type: "api_error" },
      });
    } finally {
      stopWatchingDisconnect();
    }
    return true;
  }

  setSseHeaders(res);

  let wroteRole = false;
  let wroteStopChunk = false;
  let sawAssistantDelta = false;
  let finalUsage:
    | {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
      }
    | undefined;
  let finalizeRequested = false;
  let closed = false;
  let stopWatchingDisconnect = () => {};

  const maybeFinalize = () => {
    if (closed || !finalizeRequested) {
      return;
    }
    if (streamIncludeUsage && !finalUsage) {
      return;
    }
    closed = true;
    stopWatchingDisconnect();
    unsubscribe();
    if (!wroteStopChunk) {
      writeAssistantStopChunk(res, { runId, model });
      wroteStopChunk = true;
    }
    if (streamIncludeUsage && finalUsage) {
      writeUsageChunk(res, { runId, model, usage: finalUsage });
    }
    writeDone(res);
    res.end();
  };

  const requestFinalize = () => {
    finalizeRequested = true;
    maybeFinalize();
  };

  const unsubscribe = onAgentEvent((evt) => {
    if (evt.runId !== runId) {
      return;
    }
    if (closed) {
      return;
    }

    if (evt.stream === "assistant") {
      const content = resolveAssistantStreamDeltaText(evt) ?? "";
      if (!content) {
        return;
      }

      if (!wroteRole) {
        wroteRole = true;
        writeAssistantRoleChunk(res, { runId, model });
      }

      sawAssistantDelta = true;
      writeAssistantContentChunk(res, {
        runId,
        model,
        content,
        finishReason: null,
      });
      return;
    }

    if (evt.stream === "lifecycle") {
      const phase = evt.data?.phase;
      if (phase === "end" || phase === "error") {
        requestFinalize();
      }
    }
  });

  stopWatchingDisconnect = watchClientDisconnect(req, res, abortController, () => {
    closed = true;
    unsubscribe();
  });

  void (async () => {
    try {
      const result = await agentCommandFromIngress(commandInput, defaultRuntime, deps);

      if (closed) {
        return;
      }

      finalUsage = resolveChatCompletionUsage(result);

      if (!sawAssistantDelta) {
        if (!wroteRole) {
          wroteRole = true;
          writeAssistantRoleChunk(res, { runId, model });
        }

        const content = resolveAgentResponseText(result);

        sawAssistantDelta = true;
        writeAssistantContentChunk(res, {
          runId,
          model,
          content,
          finishReason: null,
        });
      }
      requestFinalize();
    } catch (err) {
      if (closed || abortController.signal.aborted) {
        return;
      }
      logWarn(`openai-compat: streaming chat completion failed: ${String(err)}`);
      writeAssistantContentChunk(res, {
        runId,
        model,
        content: "Error: internal error",
        finishReason: "stop",
      });
      wroteStopChunk = true;
      finalUsage = {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
      };
      emitAgentEvent({
        runId,
        stream: "lifecycle",
        data: { phase: "error" },
      });
      requestFinalize();
    } finally {
      if (!closed) {
        emitAgentEvent({
          runId,
          stream: "lifecycle",
          data: { phase: "end" },
        });
      }
    }
  })();

  return true;
}

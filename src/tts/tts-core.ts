import { rmSync } from "node:fs";
import { Readable } from "node:stream";
import { completeSimple, type TextContent } from "@mariozechner/pi-ai";
import { EdgeTTS } from "node-edge-tts";
import { getApiKeyForModel, requireApiKey } from "../agents/model-auth.js";
import {
  buildModelAliasIndex,
  resolveDefaultModelForAgent,
  resolveModelRefFromString,
  type ModelRef,
} from "../agents/model-selection.js";
import { resolveModel } from "../agents/pi-embedded-runner/model.js";
import type { OpenClawConfig } from "../config/config.js";
import type {
  ResolvedTtsConfig,
  ResolvedTtsModelOverrides,
  TtsDirectiveOverrides,
  TtsDirectiveParseResult,
} from "./tts.js";

const DEFAULT_ELEVENLABS_BASE_URL = "https://api.elevenlabs.io";
const TEMP_FILE_CLEANUP_DELAY_MS = 5 * 60 * 1000; // 5 minutes

export function isValidVoiceId(voiceId: string): boolean {
  return /^[a-zA-Z0-9]{10,40}$/.test(voiceId);
}

function normalizeElevenLabsBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim();
  if (!trimmed) {
    return DEFAULT_ELEVENLABS_BASE_URL;
  }
  return trimmed.replace(/\/+$/, "");
}

function requireInRange(value: number, min: number, max: number, label: string): void {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${label} must be between ${min} and ${max}`);
  }
}

function assertElevenLabsVoiceSettings(settings: ResolvedTtsConfig["elevenlabs"]["voiceSettings"]) {
  requireInRange(settings.stability, 0, 1, "stability");
  requireInRange(settings.similarityBoost, 0, 1, "similarityBoost");
  requireInRange(settings.style, 0, 1, "style");
  requireInRange(settings.speed, 0.5, 2, "speed");
}

function normalizeLanguageCode(code?: string): string | undefined {
  const trimmed = code?.trim();
  if (!trimmed) {
    return undefined;
  }
  const normalized = trimmed.toLowerCase();
  if (!/^[a-z]{2}$/.test(normalized)) {
    throw new Error("languageCode must be a 2-letter ISO 639-1 code (e.g. en, de, fr)");
  }
  return normalized;
}

function normalizeApplyTextNormalization(mode?: string): "auto" | "on" | "off" | undefined {
  const trimmed = mode?.trim();
  if (!trimmed) {
    return undefined;
  }
  const normalized = trimmed.toLowerCase();
  if (normalized === "auto" || normalized === "on" || normalized === "off") {
    return normalized;
  }
  throw new Error("applyTextNormalization must be one of: auto, on, off");
}

function normalizeSeed(seed?: number): number | undefined {
  if (seed == null) {
    return undefined;
  }
  const next = Math.floor(seed);
  if (!Number.isFinite(next) || next < 0 || next > 4_294_967_295) {
    throw new Error("seed must be between 0 and 4294967295");
  }
  return next;
}

function parseBooleanValue(value: string): boolean | undefined {
  const normalized = value.trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["false", "0", "no", "off"].includes(normalized)) {
    return false;
  }
  return undefined;
}

function parseNumberValue(value: string): number | undefined {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function parseTtsDirectives(
  text: string,
  policy: ResolvedTtsModelOverrides,
  options?: { openaiBaseUrl?: string },
): TtsDirectiveParseResult {
  if (!policy.enabled) {
    return { cleanedText: text, overrides: {}, warnings: [], hasDirective: false };
  }

  const overrides: TtsDirectiveOverrides = {};
  const warnings: string[] = [];
  let cleanedText = text;
  let hasDirective = false;

  const blockRegex = /\[\[tts:text\]\]([\s\S]*?)\[\[\/tts:text\]\]/gi;
  cleanedText = cleanedText.replace(blockRegex, (_match, inner: string) => {
    hasDirective = true;
    if (policy.allowText && overrides.ttsText == null) {
      overrides.ttsText = inner.trim();
    }
    return "";
  });

  const directiveRegex = /\[\[tts:([^\]]+)\]\]/gi;
  cleanedText = cleanedText.replace(directiveRegex, (_match, body: string) => {
    hasDirective = true;
    const tokens = body.split(/\s+/).filter(Boolean);
    const providerHintMatch = body.match(/(?:^|\s)provider=(openai|elevenlabs|edge)(?=\s|$)/i);
    const providerHint =
      policy.allowProvider &&
      (providerHintMatch?.[1]?.toLowerCase() === "openai" ||
        providerHintMatch?.[1]?.toLowerCase() === "elevenlabs" ||
        providerHintMatch?.[1]?.toLowerCase() === "edge")
        ? (providerHintMatch[1].toLowerCase() as "openai" | "elevenlabs" | "edge")
        : undefined;
    const selectedProvider = providerHint ?? overrides.provider;

    for (let i = 0; i < tokens.length; i += 1) {
      const token = tokens[i];
      const eqIndex = token.indexOf("=");
      if (eqIndex === -1) {
        continue;
      }
      const rawKey = token.slice(0, eqIndex).trim();
      let rawValue = token.slice(eqIndex + 1).trim();
      if (!rawKey || !rawValue) {
        continue;
      }
      const key = rawKey.toLowerCase();
      try {
        switch (key) {
          case "provider":
            if (!policy.allowProvider) {
              break;
            }
            if (rawValue === "openai" || rawValue === "elevenlabs" || rawValue === "edge") {
              overrides.provider = rawValue;
            } else {
              warnings.push(`unsupported provider "${rawValue}"`);
            }
            break;
          case "voice":
          case "openai_voice":
          case "openaivoice":
            if (!policy.allowVoice) {
              break;
            }
            if (isValidOpenAIVoice(rawValue, options?.openaiBaseUrl)) {
              overrides.openai = { ...overrides.openai, voice: rawValue };
            } else {
              warnings.push(`invalid OpenAI voice "${rawValue}"`);
            }
            break;
          case "voiceid":
          case "voice_id":
          case "elevenlabs_voice":
          case "elevenlabsvoice":
            if (!policy.allowVoice) {
              break;
            }
            if (isValidVoiceId(rawValue)) {
              overrides.elevenlabs = { ...overrides.elevenlabs, voiceId: rawValue };
            } else {
              warnings.push(`invalid ElevenLabs voiceId "${rawValue}"`);
            }
            break;
          case "model":
          case "modelid":
          case "model_id":
          case "elevenlabs_model":
          case "elevenlabsmodel":
          case "openai_model":
          case "openaimodel":
            if (!policy.allowModelId) {
              break;
            }
            if (
              key === "elevenlabs_model" ||
              key === "elevenlabsmodel" ||
              key === "modelid" ||
              key === "model_id"
            ) {
              overrides.elevenlabs = { ...overrides.elevenlabs, modelId: rawValue };
              break;
            }
            if (key === "openai_model" || key === "openaimodel") {
              if (isValidOpenAIModel(rawValue, options?.openaiBaseUrl)) {
                overrides.openai = { ...overrides.openai, model: rawValue };
              } else {
                warnings.push(`invalid OpenAI model "${rawValue}"`);
              }
              break;
            }
            if (selectedProvider === "elevenlabs") {
              overrides.elevenlabs = { ...overrides.elevenlabs, modelId: rawValue };
              break;
            }
            if (selectedProvider === "openai") {
              if (isValidOpenAIModel(rawValue, options?.openaiBaseUrl)) {
                overrides.openai = { ...overrides.openai, model: rawValue };
              } else {
                warnings.push(`invalid OpenAI model "${rawValue}"`);
              }
              break;
            }
            if (isValidOpenAIModel(rawValue, options?.openaiBaseUrl)) {
              overrides.openai = { ...overrides.openai, model: rawValue };
            } else {
              overrides.elevenlabs = { ...overrides.elevenlabs, modelId: rawValue };
            }
            break;
          case "instructions":
          case "instruction":
          case "instruct":
            if (!policy.allowInstructions) {
              break;
            }
            while (i + 1 < tokens.length && !tokens[i + 1].includes("=")) {
              i += 1;
              rawValue += ` ${tokens[i]}`;
            }
            overrides.openai = { ...overrides.openai, instructions: rawValue };
            break;
          case "stream":
            if (!policy.allowStream) {
              break;
            }
            {
              const value = parseBooleanValue(rawValue);
              if (value == null) {
                warnings.push("invalid stream value");
                break;
              }
              overrides.openai = { ...overrides.openai, stream: value };
            }
            break;
          case "responseformat":
          case "response_format":
          case "format":
            if (!policy.allowResponseFormat) {
              break;
            }
            if (isValidOpenAIResponseFormat(rawValue)) {
              overrides.openai = { ...overrides.openai, responseFormat: rawValue };
            } else {
              warnings.push("invalid responseFormat value");
            }
            break;
          case "streamformat":
          case "stream_format":
            if (!policy.allowStreamFormat) {
              break;
            }
            if (isValidOpenAIStreamFormat(rawValue)) {
              overrides.openai = { ...overrides.openai, streamFormat: rawValue };
            } else {
              warnings.push("invalid streamFormat value");
            }
            break;
          case "openai_speed":
          case "openaispeed":
            if (!policy.allowSpeed) {
              break;
            }
            {
              const value = parseNumberValue(rawValue);
              if (value == null) {
                warnings.push("invalid OpenAI speed value");
                break;
              }
              requireInRange(value, 0.25, 4, "OpenAI speed");
              overrides.openai = { ...overrides.openai, speed: value };
            }
            break;
          case "stability":
            if (!policy.allowVoiceSettings) {
              break;
            }
            {
              const value = parseNumberValue(rawValue);
              if (value == null) {
                warnings.push("invalid stability value");
                break;
              }
              requireInRange(value, 0, 1, "stability");
              overrides.elevenlabs = {
                ...overrides.elevenlabs,
                voiceSettings: { ...overrides.elevenlabs?.voiceSettings, stability: value },
              };
            }
            break;
          case "similarity":
          case "similarityboost":
          case "similarity_boost":
            if (!policy.allowVoiceSettings) {
              break;
            }
            {
              const value = parseNumberValue(rawValue);
              if (value == null) {
                warnings.push("invalid similarityBoost value");
                break;
              }
              requireInRange(value, 0, 1, "similarityBoost");
              overrides.elevenlabs = {
                ...overrides.elevenlabs,
                voiceSettings: { ...overrides.elevenlabs?.voiceSettings, similarityBoost: value },
              };
            }
            break;
          case "style":
            if (!policy.allowVoiceSettings) {
              break;
            }
            {
              const value = parseNumberValue(rawValue);
              if (value == null) {
                warnings.push("invalid style value");
                break;
              }
              requireInRange(value, 0, 1, "style");
              overrides.elevenlabs = {
                ...overrides.elevenlabs,
                voiceSettings: { ...overrides.elevenlabs?.voiceSettings, style: value },
              };
            }
            break;
          case "speed":
            if (!policy.allowVoiceSettings) {
              break;
            }
            {
              const value = parseNumberValue(rawValue);
              if (value == null) {
                warnings.push("invalid speed value");
                break;
              }
              requireInRange(value, 0.5, 2, "speed");
              overrides.elevenlabs = {
                ...overrides.elevenlabs,
                voiceSettings: { ...overrides.elevenlabs?.voiceSettings, speed: value },
              };
            }
            break;
          case "speakerboost":
          case "speaker_boost":
          case "usespeakerboost":
          case "use_speaker_boost":
            if (!policy.allowVoiceSettings) {
              break;
            }
            {
              const value = parseBooleanValue(rawValue);
              if (value == null) {
                warnings.push("invalid useSpeakerBoost value");
                break;
              }
              overrides.elevenlabs = {
                ...overrides.elevenlabs,
                voiceSettings: { ...overrides.elevenlabs?.voiceSettings, useSpeakerBoost: value },
              };
            }
            break;
          case "normalize":
          case "applytextnormalization":
          case "apply_text_normalization":
            if (!policy.allowNormalization) {
              break;
            }
            overrides.elevenlabs = {
              ...overrides.elevenlabs,
              applyTextNormalization: normalizeApplyTextNormalization(rawValue),
            };
            break;
          case "language":
          case "languagecode":
          case "language_code":
            if (!policy.allowNormalization) {
              break;
            }
            overrides.elevenlabs = {
              ...overrides.elevenlabs,
              languageCode: normalizeLanguageCode(rawValue),
            };
            break;
          case "seed":
            if (!policy.allowSeed) {
              break;
            }
            overrides.elevenlabs = {
              ...overrides.elevenlabs,
              seed: normalizeSeed(Number.parseInt(rawValue, 10)),
            };
            break;
          default:
            break;
        }
      } catch (err) {
        warnings.push((err as Error).message);
      }
    }
    return "";
  });

  return {
    cleanedText,
    ttsText: overrides.ttsText,
    hasDirective,
    overrides,
    warnings,
  };
}

export const OPENAI_TTS_MODELS = ["gpt-4o-mini-tts", "tts-1", "tts-1-hd"] as const;
export const OPENAI_TTS_RESPONSE_FORMATS = ["mp3", "opus", "aac", "flac", "wav", "pcm"] as const;
export const OPENAI_TTS_STREAM_FORMATS = ["audio", "sse"] as const;
const OPENAI_TTS_MODELS_WITH_STREAMING = new Set<string>(["gpt-4o-mini-tts"]);
const DEFAULT_OPENAI_TTS_BASE_URL = "https://api.openai.com/v1";

/**
 * Custom OpenAI-compatible TTS endpoint.
 * When set, model/voice validation is relaxed to allow non-OpenAI models.
 * Example: OPENAI_TTS_BASE_URL=http://localhost:8880/v1
 *
 * Note: Read at runtime (not module load) to support config.env loading.
 */
function getOpenAITtsBaseUrl(baseUrl?: string): string {
  return (
    baseUrl?.trim() ||
    process.env.OPENAI_TTS_BASE_URL?.trim() ||
    DEFAULT_OPENAI_TTS_BASE_URL
  ).replace(/\/+$/, "");
}

function isCustomOpenAIEndpoint(baseUrl?: string): boolean {
  return getOpenAITtsBaseUrl(baseUrl) !== DEFAULT_OPENAI_TTS_BASE_URL;
}
export const OPENAI_TTS_VOICES = [
  "alloy",
  "ash",
  "ballad",
  "cedar",
  "coral",
  "echo",
  "fable",
  "juniper",
  "marin",
  "onyx",
  "nova",
  "sage",
  "shimmer",
  "verse",
] as const;

type OpenAiTtsVoice = (typeof OPENAI_TTS_VOICES)[number];
type OpenAiTtsResponseFormat = (typeof OPENAI_TTS_RESPONSE_FORMATS)[number];
type OpenAiTtsStreamFormat = (typeof OPENAI_TTS_STREAM_FORMATS)[number];

export function isValidOpenAIModel(model: string, baseUrl?: string): boolean {
  // Allow any model when using custom endpoint (e.g., Kokoro, LocalAI)
  if (isCustomOpenAIEndpoint(baseUrl)) {
    return true;
  }
  return OPENAI_TTS_MODELS.includes(model as (typeof OPENAI_TTS_MODELS)[number]);
}

function supportsOpenAIStreaming(model: string, baseUrl?: string): boolean {
  return isCustomOpenAIEndpoint(baseUrl) || OPENAI_TTS_MODELS_WITH_STREAMING.has(model);
}

function isUnsupportedInstructionsApiError(error: Error): boolean {
  const normalized = error.message.toLowerCase();
  const hasUnsupportedSignal =
    normalized.includes("unsupported") ||
    normalized.includes("not supported") ||
    normalized.includes("unknown parameter") ||
    normalized.includes("unrecognized request argument");

  return (
    (normalized.includes("instruction") && hasUnsupportedSignal) ||
    normalized.includes("extra inputs are not permitted") ||
    normalized.includes("additional properties are not allowed")
  );
}

export function isValidOpenAIVoice(voice: string, baseUrl?: string): voice is OpenAiTtsVoice {
  // Allow any voice when using custom endpoint (e.g., Kokoro Chinese voices)
  if (isCustomOpenAIEndpoint(baseUrl)) {
    return true;
  }
  return OPENAI_TTS_VOICES.includes(voice as OpenAiTtsVoice);
}

export function isValidOpenAIResponseFormat(
  responseFormat: string,
): responseFormat is OpenAiTtsResponseFormat {
  return OPENAI_TTS_RESPONSE_FORMATS.includes(responseFormat as OpenAiTtsResponseFormat);
}

export function isValidOpenAIStreamFormat(
  streamFormat: string,
): streamFormat is OpenAiTtsStreamFormat {
  return OPENAI_TTS_STREAM_FORMATS.includes(streamFormat as OpenAiTtsStreamFormat);
}

function normalizeOpenAiContentType(contentType: string | null): string {
  return (contentType ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
}

function inferOpenAiFormatFromContentType(
  contentType: string | null,
): OpenAiTtsResponseFormat | undefined {
  const normalized = normalizeOpenAiContentType(contentType);
  if (!normalized) {
    return undefined;
  }
  if (normalized === "audio/mpeg" || normalized === "audio/mp3") {
    return "mp3";
  }
  if (
    normalized === "audio/opus" ||
    normalized === "audio/ogg" ||
    normalized === "application/ogg"
  ) {
    return "opus";
  }
  if (
    normalized === "audio/aac" ||
    normalized === "audio/mp4" ||
    normalized === "audio/x-m4a" ||
    normalized === "audio/m4a"
  ) {
    return "aac";
  }
  if (normalized === "audio/flac" || normalized === "audio/x-flac") {
    return "flac";
  }
  if (
    normalized === "audio/wav" ||
    normalized === "audio/wave" ||
    normalized === "audio/x-wav" ||
    normalized === "audio/vnd.wave"
  ) {
    return "wav";
  }
  if (normalized === "audio/pcm" || normalized === "audio/l16") {
    return "pcm";
  }
  return undefined;
}

function inferOpenAiFormatFromBytes(audio: Buffer): OpenAiTtsResponseFormat | undefined {
  if (audio.length >= 4 && audio.subarray(0, 4).toString("ascii") === "fLaC") {
    return "flac";
  }
  if (
    audio.length >= 12 &&
    audio.subarray(0, 4).toString("ascii") === "RIFF" &&
    audio.subarray(8, 12).toString("ascii") === "WAVE"
  ) {
    return "wav";
  }
  if (audio.length >= 4 && audio.subarray(0, 4).toString("ascii") === "OggS") {
    return "opus";
  }
  if (audio.length >= 3 && audio.subarray(0, 3).toString("ascii") === "ID3") {
    return "mp3";
  }
  // MP3 frame headers can start with 0xFF syncword (e.g. 0xFF 0xFB).
  // Distinguish MP3 from AAC ADTS by layer bits: MP3 layer bits are not 00, while AAC ADTS layer bits are 00.
  if (audio.length >= 2 && audio[0] === 0xff && (audio[1] & 0xf0) === 0xf0) {
    const adtsLayerBits = audio[1] & 0x06;
    if (adtsLayerBits === 0x00) {
      return "aac";
    }
    return "mp3";
  }
  return undefined;
}

function resolveOpenAiReturnedFormat(params: {
  requested?: OpenAiTtsResponseFormat;
  contentType: string | null;
  audioBuffer?: Buffer;
}): OpenAiTtsResponseFormat {
  const fromContentType = inferOpenAiFormatFromContentType(params.contentType);
  const fromBytes = params.audioBuffer ? inferOpenAiFormatFromBytes(params.audioBuffer) : undefined;
  const detected = fromBytes ?? fromContentType;

  if (params.requested && detected && detected !== params.requested) {
    throw new Error(
      `OpenAI TTS returned ${detected} but ${params.requested} was requested. ` +
        `Align messages.tts.openai.responseFormat with upstream output or fix the upstream endpoint.`,
    );
  }
  return detected ?? params.requested ?? "mp3";
}

async function buildOpenAiTtsApiError(response: Response): Promise<Error> {
  let details = "";
  try {
    if (typeof response.text === "function") {
      const raw = await response.text();
      const trimmed = raw.trim();
      if (trimmed) {
        try {
          const parsed = JSON.parse(trimmed) as {
            error?: { message?: string } | string;
            message?: string;
          };
          if (typeof parsed.error === "string") {
            details = parsed.error;
          } else if (typeof parsed.error?.message === "string") {
            details = parsed.error.message;
          } else if (typeof parsed.message === "string") {
            details = parsed.message;
          } else {
            details = trimmed;
          }
        } catch {
          details = trimmed;
        }
      }
    }
  } catch {
    // ignore body parse failures and fall back to status-only error
  }
  const suffix = details ? `: ${details}` : "";
  return new Error(`OpenAI TTS API error (${response.status})${suffix}`);
}

type SummarizeResult = {
  summary: string;
  latencyMs: number;
  inputLength: number;
  outputLength: number;
};

type SummaryModelSelection = {
  ref: ModelRef;
  source: "summaryModel" | "default";
};

function resolveSummaryModelRef(
  cfg: OpenClawConfig,
  config: ResolvedTtsConfig,
): SummaryModelSelection {
  const defaultRef = resolveDefaultModelForAgent({ cfg });
  const override = config.summaryModel?.trim();
  if (!override) {
    return { ref: defaultRef, source: "default" };
  }

  const aliasIndex = buildModelAliasIndex({ cfg, defaultProvider: defaultRef.provider });
  const resolved = resolveModelRefFromString({
    raw: override,
    defaultProvider: defaultRef.provider,
    aliasIndex,
  });
  if (!resolved) {
    return { ref: defaultRef, source: "default" };
  }
  return { ref: resolved.ref, source: "summaryModel" };
}

function isTextContentBlock(block: { type: string }): block is TextContent {
  return block.type === "text";
}

export async function summarizeText(params: {
  text: string;
  targetLength: number;
  cfg: OpenClawConfig;
  config: ResolvedTtsConfig;
  timeoutMs: number;
}): Promise<SummarizeResult> {
  const { text, targetLength, cfg, config, timeoutMs } = params;
  if (targetLength < 100 || targetLength > 10_000) {
    throw new Error(`Invalid targetLength: ${targetLength}`);
  }

  const startTime = Date.now();
  const { ref } = resolveSummaryModelRef(cfg, config);
  const resolved = resolveModel(ref.provider, ref.model, undefined, cfg);
  if (!resolved.model) {
    throw new Error(resolved.error ?? `Unknown summary model: ${ref.provider}/${ref.model}`);
  }
  const apiKey = requireApiKey(
    await getApiKeyForModel({ model: resolved.model, cfg }),
    ref.provider,
  );

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await completeSimple(
        resolved.model,
        {
          messages: [
            {
              role: "user",
              content:
                `You are an assistant that summarizes texts concisely while keeping the most important information. ` +
                `Summarize the text to approximately ${targetLength} characters. Maintain the original tone and style. ` +
                `Reply only with the summary, without additional explanations.\n\n` +
                `<text_to_summarize>\n${text}\n</text_to_summarize>`,
              timestamp: Date.now(),
            },
          ],
        },
        {
          apiKey,
          maxTokens: Math.ceil(targetLength / 2),
          temperature: 0.3,
          signal: controller.signal,
        },
      );

      const summary = res.content
        .filter(isTextContentBlock)
        .map((block) => block.text.trim())
        .filter(Boolean)
        .join(" ")
        .trim();

      if (!summary) {
        throw new Error("No summary returned");
      }

      return {
        summary,
        latencyMs: Date.now() - startTime,
        inputLength: text.length,
        outputLength: summary.length,
      };
    } finally {
      clearTimeout(timeout);
    }
  } catch (err) {
    const error = err as Error;
    if (error.name === "AbortError") {
      throw new Error("Summarization timed out", { cause: err });
    }
    throw err;
  }
}

export function scheduleCleanup(
  tempDir: string,
  delayMs: number = TEMP_FILE_CLEANUP_DELAY_MS,
): void {
  const timer = setTimeout(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  }, delayMs);
  timer.unref();
}

export async function elevenLabsTTS(params: {
  text: string;
  apiKey: string;
  baseUrl: string;
  voiceId: string;
  modelId: string;
  outputFormat: string;
  seed?: number;
  applyTextNormalization?: "auto" | "on" | "off";
  languageCode?: string;
  voiceSettings: ResolvedTtsConfig["elevenlabs"]["voiceSettings"];
  timeoutMs: number;
}): Promise<Buffer> {
  const {
    text,
    apiKey,
    baseUrl,
    voiceId,
    modelId,
    outputFormat,
    seed,
    applyTextNormalization,
    languageCode,
    voiceSettings,
    timeoutMs,
  } = params;
  if (!isValidVoiceId(voiceId)) {
    throw new Error("Invalid voiceId format");
  }
  assertElevenLabsVoiceSettings(voiceSettings);
  const normalizedLanguage = normalizeLanguageCode(languageCode);
  const normalizedNormalization = normalizeApplyTextNormalization(applyTextNormalization);
  const normalizedSeed = normalizeSeed(seed);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const url = new URL(`${normalizeElevenLabsBaseUrl(baseUrl)}/v1/text-to-speech/${voiceId}`);
    if (outputFormat) {
      url.searchParams.set("output_format", outputFormat);
    }

    const response = await fetch(url.toString(), {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
      },
      body: JSON.stringify({
        text,
        model_id: modelId,
        seed: normalizedSeed,
        apply_text_normalization: normalizedNormalization,
        language_code: normalizedLanguage,
        voice_settings: {
          stability: voiceSettings.stability,
          similarity_boost: voiceSettings.similarityBoost,
          style: voiceSettings.style,
          use_speaker_boost: voiceSettings.useSpeakerBoost,
          speed: voiceSettings.speed,
        },
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`ElevenLabs API error (${response.status})`);
    }

    return Buffer.from(await response.arrayBuffer());
  } finally {
    clearTimeout(timeout);
  }
}

export async function openaiTTS(params: {
  text: string;
  apiKey: string;
  model: string;
  voice: string;
  responseFormat?: OpenAiTtsResponseFormat;
  speed?: number;
  instructions?: string;
  instructionsExplicit?: boolean;
  stream?: boolean;
  streamFormat?: OpenAiTtsStreamFormat;
  streamFallbackToBuffered?: boolean;
  timeoutMs: number;
  baseUrl?: string;
}): Promise<{ audioBuffer: Buffer; outputFormat: OpenAiTtsResponseFormat }> {
  const {
    text,
    apiKey,
    model,
    voice,
    responseFormat,
    speed,
    instructions,
    instructionsExplicit = false,
    stream,
    streamFormat,
    streamFallbackToBuffered = true,
    timeoutMs,
    baseUrl,
  } = params;

  if (!isValidOpenAIModel(model, baseUrl)) {
    throw new Error(`Invalid model: ${model}`);
  }
  if (!isValidOpenAIVoice(voice, baseUrl)) {
    throw new Error(`Invalid voice: ${voice}`);
  }
  if (speed != null && (!Number.isFinite(speed) || speed < 0.25 || speed > 4)) {
    throw new Error("OpenAI speed must be between 0.25 and 4.0");
  }
  const normalizedInstructions = instructions?.trim();
  if (stream === true && !supportsOpenAIStreaming(model, baseUrl)) {
    throw new Error(
      `OpenAI stream mode is unsupported for model ${model}; use gpt-4o-mini-tts or disable stream.`,
    );
  }
  if (stream === true && streamFormat === "sse") {
    throw new Error(
      "OpenAI streamFormat=sse is not supported by OpenClaw audio playback yet; use streamFormat=audio.",
    );
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const makeRequest = async (
      enableStream: boolean,
      includeInstructions: boolean,
      signal: AbortSignal = controller.signal,
    ): Promise<Response> =>
      fetch(`${getOpenAITtsBaseUrl(baseUrl)}/audio/speech`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          input: text,
          voice,
          ...(responseFormat != null ? { response_format: responseFormat } : {}),
          ...(speed != null ? { speed } : {}),
          ...(includeInstructions && normalizedInstructions
            ? { instructions: normalizedInstructions }
            : {}),
          ...(enableStream ? { stream: true } : {}),
          ...(enableStream && streamFormat ? { stream_format: streamFormat } : {}),
        }),
        signal,
      });

    const requestWithUnsupportedInstructionsRetry = async (
      enableStream: boolean,
      signal: AbortSignal = controller.signal,
    ): Promise<Response> => {
      let includeInstructions = Boolean(normalizedInstructions);
      let retriedWithoutInstructions = false;

      while (true) {
        const response = await makeRequest(enableStream, includeInstructions, signal);
        if (response.ok) {
          return response;
        }
        const apiError = await buildOpenAiTtsApiError(response);
        if (
          includeInstructions &&
          !instructionsExplicit &&
          !retriedWithoutInstructions &&
          isUnsupportedInstructionsApiError(apiError)
        ) {
          includeInstructions = false;
          retriedWithoutInstructions = true;
          continue;
        }
        throw apiError;
      }
    };

    const toResult = async (res: Response) => {
      const audioBuffer = Buffer.from(await res.arrayBuffer());
      return {
        audioBuffer,
        outputFormat: resolveOpenAiReturnedFormat({
          requested: responseFormat,
          contentType: res.headers?.get?.("content-type") ?? null,
          audioBuffer,
        }),
      };
    };

    const attemptBufferedFallback = async (cause?: unknown) => {
      const fallbackController = new AbortController();
      const fallbackTimeout = setTimeout(() => fallbackController.abort(), timeoutMs);
      try {
        const fallback = await requestWithUnsupportedInstructionsRetry(
          false,
          fallbackController.signal,
        );
        return toResult(fallback);
      } catch (fallbackError) {
        if (cause != null) {
          throw new Error(
            fallbackError instanceof Error ? fallbackError.message : "OpenAI TTS fallback error",
            { cause: fallbackError },
          );
        }
        throw fallbackError;
      } finally {
        clearTimeout(fallbackTimeout);
      }
    };

    const shouldRequestStream = stream === true;
    if (shouldRequestStream) {
      try {
        const streamResponse = await requestWithUnsupportedInstructionsRetry(true);
        return toResult(streamResponse);
      } catch (err) {
        if (streamFallbackToBuffered) {
          return attemptBufferedFallback(err);
        }
        throw err;
      }
    }

    const response = await requestWithUnsupportedInstructionsRetry(false);
    return toResult(response);
  } finally {
    clearTimeout(timeout);
  }
}

export async function openaiTTSReadable(params: {
  text: string;
  apiKey: string;
  model: string;
  voice: string;
  responseFormat?: OpenAiTtsResponseFormat;
  speed?: number;
  instructions?: string;
  instructionsExplicit?: boolean;
  streamFormat?: OpenAiTtsStreamFormat;
  timeoutMs: number;
  baseUrl?: string;
}): Promise<{ stream: Readable; progressive: boolean; outputFormat: OpenAiTtsResponseFormat }> {
  const {
    text,
    apiKey,
    model,
    voice,
    responseFormat,
    speed,
    instructions,
    instructionsExplicit = false,
    streamFormat,
    timeoutMs,
    baseUrl,
  } = params;
  if (!isValidOpenAIModel(model, baseUrl)) {
    throw new Error(`Invalid model: ${model}`);
  }
  if (!isValidOpenAIVoice(voice, baseUrl)) {
    throw new Error(`Invalid voice: ${voice}`);
  }
  if (speed != null && (!Number.isFinite(speed) || speed < 0.25 || speed > 4)) {
    throw new Error("OpenAI speed must be between 0.25 and 4.0");
  }
  const normalizedInstructions = instructions?.trim();
  if (!supportsOpenAIStreaming(model, baseUrl)) {
    throw new Error(
      `OpenAI stream mode is unsupported for model ${model}; use gpt-4o-mini-tts or disable stream.`,
    );
  }
  if (streamFormat === "sse") {
    throw new Error(
      "OpenAI streamFormat=sse is not supported by OpenClaw audio playback yet; use streamFormat=audio.",
    );
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  const clearAbortTimer = () => {
    clearTimeout(timeout);
  };

  try {
    let includeInstructions = Boolean(normalizedInstructions);
    let retriedWithoutInstructions = false;
    let response: Response;
    while (true) {
      response = await fetch(`${getOpenAITtsBaseUrl(baseUrl)}/audio/speech`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          input: text,
          voice,
          ...(responseFormat != null ? { response_format: responseFormat } : {}),
          ...(speed != null ? { speed } : {}),
          ...(includeInstructions && normalizedInstructions
            ? { instructions: normalizedInstructions }
            : {}),
          stream: true,
          ...(streamFormat ? { stream_format: streamFormat } : {}),
        }),
        signal: controller.signal,
      });

      if (response.ok) {
        break;
      }

      const apiError = await buildOpenAiTtsApiError(response);
      if (
        includeInstructions &&
        !instructionsExplicit &&
        !retriedWithoutInstructions &&
        isUnsupportedInstructionsApiError(apiError)
      ) {
        includeInstructions = false;
        retriedWithoutInstructions = true;
        continue;
      }

      throw apiError;
    }

    if (!response.body) {
      throw new Error("OpenAI TTS API returned no response body");
    }

    const outputFormat = resolveOpenAiReturnedFormat({
      requested: responseFormat,
      contentType: response.headers?.get?.("content-type") ?? null,
    });

    const stream = Readable.fromWeb(response.body as import("node:stream/web").ReadableStream);
    stream.once("end", clearAbortTimer);
    stream.once("error", clearAbortTimer);
    stream.once("close", clearAbortTimer);

    return {
      stream,
      progressive: true,
      outputFormat,
    };
  } catch (err) {
    clearAbortTimer();
    throw err;
  }
}

export function inferEdgeExtension(outputFormat: string): string {
  const normalized = outputFormat.toLowerCase();
  if (normalized.includes("webm")) {
    return ".webm";
  }
  if (normalized.includes("ogg")) {
    return ".ogg";
  }
  if (normalized.includes("opus")) {
    return ".opus";
  }
  if (normalized.includes("wav") || normalized.includes("riff") || normalized.includes("pcm")) {
    return ".wav";
  }
  return ".mp3";
}

export async function edgeTTS(params: {
  text: string;
  outputPath: string;
  config: ResolvedTtsConfig["edge"];
  timeoutMs: number;
}): Promise<void> {
  const { text, outputPath, config, timeoutMs } = params;
  const tts = new EdgeTTS({
    voice: config.voice,
    lang: config.lang,
    outputFormat: config.outputFormat,
    saveSubtitles: config.saveSubtitles,
    proxy: config.proxy,
    rate: config.rate,
    pitch: config.pitch,
    volume: config.volume,
    timeout: config.timeoutMs ?? timeoutMs,
  });
  await tts.ttsPromise(text, outputPath);
}

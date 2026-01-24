import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  mkdtempSync,
  rmSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ReplyPayload } from "../auto-reply/types.js";
import { normalizeChannelId } from "../channels/plugins/index.js";
import type { ChannelId } from "../channels/plugins/types.js";
import type { ClawdbotConfig } from "../config/config.js";
import type { TtsConfig, TtsMode, TtsProvider } from "../config/types.tts.js";
import { logVerbose } from "../globals.js";
import { CONFIG_DIR, resolveUserPath } from "../utils.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_TTS_MAX_LENGTH = 1500;
const DEFAULT_TTS_SUMMARIZE = true;
const DEFAULT_MAX_TEXT_LENGTH = 4000;
const TEMP_FILE_CLEANUP_DELAY_MS = 5 * 60 * 1000; // 5 minutes

const DEFAULT_ELEVENLABS_VOICE_ID = "pMsXgVXv3BLzUgSXRplE";
const DEFAULT_ELEVENLABS_MODEL_ID = "eleven_multilingual_v2";
const DEFAULT_OPENAI_MODEL = "gpt-4o-mini-tts";
const DEFAULT_OPENAI_VOICE = "alloy";

const TELEGRAM_OUTPUT = {
  openai: "opus" as const,
  // ElevenLabs output formats use codec_sample_rate_bitrate naming.
  // Opus @ 48kHz/64kbps is a good voice-note tradeoff for Telegram.
  elevenlabs: "opus_48000_64",
  extension: ".opus",
  voiceCompatible: true,
};

const DEFAULT_OUTPUT = {
  openai: "mp3" as const,
  elevenlabs: "mp3_44100_128",
  extension: ".mp3",
  voiceCompatible: false,
};

export type ResolvedTtsConfig = {
  enabled: boolean;
  mode: TtsMode;
  provider: TtsProvider;
  elevenlabs: {
    apiKey?: string;
    voiceId: string;
    modelId: string;
  };
  openai: {
    apiKey?: string;
    model: string;
    voice: string;
  };
  prefsPath?: string;
  maxTextLength: number;
  timeoutMs: number;
};

type TtsUserPrefs = {
  tts?: {
    enabled?: boolean;
    provider?: TtsProvider;
    maxLength?: number;
    summarize?: boolean;
  };
};

export type TtsResult = {
  success: boolean;
  audioPath?: string;
  error?: string;
  latencyMs?: number;
  provider?: string;
  outputFormat?: string;
  voiceCompatible?: boolean;
};

type TtsStatusEntry = {
  timestamp: number;
  success: boolean;
  textLength: number;
  summarized: boolean;
  provider?: string;
  latencyMs?: number;
  error?: string;
};

let lastTtsAttempt: TtsStatusEntry | undefined;

export function resolveTtsConfig(cfg: ClawdbotConfig): ResolvedTtsConfig {
  const raw: TtsConfig = cfg.messages?.tts ?? {};
  return {
    enabled: raw.enabled ?? false,
    mode: raw.mode ?? "final",
    provider: raw.provider ?? "elevenlabs",
    elevenlabs: {
      apiKey: raw.elevenlabs?.apiKey,
      voiceId: raw.elevenlabs?.voiceId ?? DEFAULT_ELEVENLABS_VOICE_ID,
      modelId: raw.elevenlabs?.modelId ?? DEFAULT_ELEVENLABS_MODEL_ID,
    },
    openai: {
      apiKey: raw.openai?.apiKey,
      model: raw.openai?.model ?? DEFAULT_OPENAI_MODEL,
      voice: raw.openai?.voice ?? DEFAULT_OPENAI_VOICE,
    },
    prefsPath: raw.prefsPath,
    maxTextLength: raw.maxTextLength ?? DEFAULT_MAX_TEXT_LENGTH,
    timeoutMs: raw.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  };
}

export function resolveTtsPrefsPath(config: ResolvedTtsConfig): string {
  if (config.prefsPath?.trim()) return resolveUserPath(config.prefsPath.trim());
  const envPath = process.env.CLAWDBOT_TTS_PREFS?.trim();
  if (envPath) return resolveUserPath(envPath);
  return path.join(CONFIG_DIR, "settings", "tts.json");
}

function readPrefs(prefsPath: string): TtsUserPrefs {
  try {
    if (!existsSync(prefsPath)) return {};
    return JSON.parse(readFileSync(prefsPath, "utf8")) as TtsUserPrefs;
  } catch {
    return {};
  }
}

function atomicWriteFileSync(filePath: string, content: string): void {
  const tmpPath = `${filePath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2)}`;
  writeFileSync(tmpPath, content);
  try {
    renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // ignore
    }
    throw err;
  }
}

function updatePrefs(prefsPath: string, update: (prefs: TtsUserPrefs) => void): void {
  const prefs = readPrefs(prefsPath);
  update(prefs);
  mkdirSync(path.dirname(prefsPath), { recursive: true });
  atomicWriteFileSync(prefsPath, JSON.stringify(prefs, null, 2));
}

export function isTtsEnabled(config: ResolvedTtsConfig, prefsPath: string): boolean {
  const prefs = readPrefs(prefsPath);
  if (prefs.tts?.enabled !== undefined) return prefs.tts.enabled === true;
  return config.enabled;
}

export function setTtsEnabled(prefsPath: string, enabled: boolean): void {
  updatePrefs(prefsPath, (prefs) => {
    prefs.tts = { ...prefs.tts, enabled };
  });
}

export function getTtsProvider(config: ResolvedTtsConfig, prefsPath: string): TtsProvider {
  const prefs = readPrefs(prefsPath);
  return prefs.tts?.provider ?? config.provider;
}

export function setTtsProvider(prefsPath: string, provider: TtsProvider): void {
  updatePrefs(prefsPath, (prefs) => {
    prefs.tts = { ...prefs.tts, provider };
  });
}

export function getTtsMaxLength(prefsPath: string): number {
  const prefs = readPrefs(prefsPath);
  return prefs.tts?.maxLength ?? DEFAULT_TTS_MAX_LENGTH;
}

export function setTtsMaxLength(prefsPath: string, maxLength: number): void {
  updatePrefs(prefsPath, (prefs) => {
    prefs.tts = { ...prefs.tts, maxLength };
  });
}

export function isSummarizationEnabled(prefsPath: string): boolean {
  const prefs = readPrefs(prefsPath);
  return prefs.tts?.summarize ?? DEFAULT_TTS_SUMMARIZE;
}

export function setSummarizationEnabled(prefsPath: string, enabled: boolean): void {
  updatePrefs(prefsPath, (prefs) => {
    prefs.tts = { ...prefs.tts, summarize: enabled };
  });
}

export function getLastTtsAttempt(): TtsStatusEntry | undefined {
  return lastTtsAttempt;
}

export function setLastTtsAttempt(entry: TtsStatusEntry | undefined): void {
  lastTtsAttempt = entry;
}

function resolveOutputFormat(channelId?: string | null) {
  if (channelId === "telegram") return TELEGRAM_OUTPUT;
  return DEFAULT_OUTPUT;
}

function resolveChannelId(channel: string | undefined): ChannelId | null {
  return channel ? normalizeChannelId(channel) : null;
}

export function resolveTtsApiKey(
  config: ResolvedTtsConfig,
  provider: TtsProvider,
): string | undefined {
  if (provider === "elevenlabs") {
    return config.elevenlabs.apiKey || process.env.ELEVENLABS_API_KEY || process.env.XI_API_KEY;
  }
  if (provider === "openai") {
    return config.openai.apiKey || process.env.OPENAI_API_KEY;
  }
  return undefined;
}

function isValidVoiceId(voiceId: string): boolean {
  return /^[a-zA-Z0-9]{10,40}$/.test(voiceId);
}

export const OPENAI_TTS_MODELS = ["gpt-4o-mini-tts"] as const;
export const OPENAI_TTS_VOICES = [
  "alloy",
  "ash",
  "coral",
  "echo",
  "fable",
  "onyx",
  "nova",
  "sage",
  "shimmer",
] as const;

type OpenAiTtsVoice = (typeof OPENAI_TTS_VOICES)[number];

function isValidOpenAIModel(model: string): boolean {
  return OPENAI_TTS_MODELS.includes(model as (typeof OPENAI_TTS_MODELS)[number]);
}

function isValidOpenAIVoice(voice: string): voice is OpenAiTtsVoice {
  return OPENAI_TTS_VOICES.includes(voice as OpenAiTtsVoice);
}

type SummarizeResult = {
  summary: string;
  latencyMs: number;
  inputLength: number;
  outputLength: number;
};

async function summarizeText(
  text: string,
  targetLength: number,
  apiKey: string,
  timeoutMs: number,
): Promise<SummarizeResult> {
  if (targetLength < 100 || targetLength > 10_000) {
    throw new Error(`Invalid targetLength: ${targetLength}`);
  }

  const startTime = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: `You are an assistant that summarizes texts concisely while keeping the most important information. Summarize the text to approximately ${targetLength} characters. Maintain the original tone and style. Reply only with the summary, without additional explanations.`,
          },
          {
            role: "user",
            content: `<text_to_summarize>\n${text}\n</text_to_summarize>`,
          },
        ],
        max_tokens: Math.ceil(targetLength / 2),
        temperature: 0.3,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error("Summarization service unavailable");
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const summary = data.choices?.[0]?.message?.content?.trim();

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
}

function scheduleCleanup(tempDir: string, delayMs: number = TEMP_FILE_CLEANUP_DELAY_MS): void {
  const timer = setTimeout(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  }, delayMs);
  timer.unref();
}

async function elevenLabsTTS(params: {
  text: string;
  apiKey: string;
  voiceId: string;
  modelId: string;
  outputFormat: string;
  timeoutMs: number;
}): Promise<Buffer> {
  const { text, apiKey, voiceId, modelId, outputFormat, timeoutMs } = params;
  if (!isValidVoiceId(voiceId)) {
    throw new Error("Invalid voiceId format");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const url = new URL(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`);
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
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75,
          style: 0.0,
          use_speaker_boost: true,
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

async function openaiTTS(params: {
  text: string;
  apiKey: string;
  model: string;
  voice: string;
  responseFormat: "mp3" | "opus";
  timeoutMs: number;
}): Promise<Buffer> {
  const { text, apiKey, model, voice, responseFormat, timeoutMs } = params;

  if (!isValidOpenAIModel(model)) {
    throw new Error(`Invalid model: ${model}`);
  }
  if (!isValidOpenAIVoice(voice)) {
    throw new Error(`Invalid voice: ${voice}`);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        input: text,
        voice,
        response_format: responseFormat,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`OpenAI TTS API error (${response.status})`);
    }

    return Buffer.from(await response.arrayBuffer());
  } finally {
    clearTimeout(timeout);
  }
}

export async function textToSpeech(params: {
  text: string;
  cfg: ClawdbotConfig;
  prefsPath?: string;
  channel?: string;
}): Promise<TtsResult> {
  const config = resolveTtsConfig(params.cfg);
  const prefsPath = params.prefsPath ?? resolveTtsPrefsPath(config);
  const channelId = resolveChannelId(params.channel);
  const output = resolveOutputFormat(channelId);

  if (params.text.length > config.maxTextLength) {
    return {
      success: false,
      error: `Text too long (${params.text.length} chars, max ${config.maxTextLength})`,
    };
  }

  const userProvider = getTtsProvider(config, prefsPath);
  const providers: TtsProvider[] = [
    userProvider,
    userProvider === "openai" ? "elevenlabs" : "openai",
  ];

  let lastError: string | undefined;

  for (const provider of providers) {
    const apiKey = resolveTtsApiKey(config, provider);
    if (!apiKey) {
      lastError = `No API key for ${provider}`;
      continue;
    }

    const providerStart = Date.now();
    try {
      let audioBuffer: Buffer;
      if (provider === "elevenlabs") {
        audioBuffer = await elevenLabsTTS({
          text: params.text,
          apiKey,
          voiceId: config.elevenlabs.voiceId,
          modelId: config.elevenlabs.modelId,
          outputFormat: output.elevenlabs,
          timeoutMs: config.timeoutMs,
        });
      } else {
        audioBuffer = await openaiTTS({
          text: params.text,
          apiKey,
          model: config.openai.model,
          voice: config.openai.voice,
          responseFormat: output.openai,
          timeoutMs: config.timeoutMs,
        });
      }

      const latencyMs = Date.now() - providerStart;

      const tempDir = mkdtempSync(path.join(tmpdir(), "tts-"));
      const audioPath = path.join(tempDir, `voice-${Date.now()}${output.extension}`);
      writeFileSync(audioPath, audioBuffer);
      scheduleCleanup(tempDir);

      return {
        success: true,
        audioPath,
        latencyMs,
        provider,
        outputFormat: provider === "openai" ? output.openai : output.elevenlabs,
        voiceCompatible: output.voiceCompatible,
      };
    } catch (err) {
      const error = err as Error;
      if (error.name === "AbortError") {
        lastError = `${provider}: request timed out`;
      } else {
        lastError = `${provider}: ${error.message}`;
      }
    }
  }

  return {
    success: false,
    error: `TTS conversion failed: ${lastError || "no providers available"}`,
  };
}

export async function maybeApplyTtsToPayload(params: {
  payload: ReplyPayload;
  cfg: ClawdbotConfig;
  channel?: string;
  kind?: "tool" | "block" | "final";
}): Promise<ReplyPayload> {
  const config = resolveTtsConfig(params.cfg);
  const prefsPath = resolveTtsPrefsPath(config);
  if (!isTtsEnabled(config, prefsPath)) return params.payload;

  const mode = config.mode ?? "final";
  if (mode === "final" && params.kind && params.kind !== "final") return params.payload;

  const text = params.payload.text ?? "";
  if (!text.trim()) return params.payload;
  if (params.payload.mediaUrl || (params.payload.mediaUrls?.length ?? 0) > 0) return params.payload;
  if (text.includes("MEDIA:")) return params.payload;
  if (text.trim().length < 10) return params.payload;

  const maxLength = getTtsMaxLength(prefsPath);
  let textForAudio = text.trim();
  let wasSummarized = false;

  if (textForAudio.length > maxLength) {
    if (!isSummarizationEnabled(prefsPath)) {
      logVerbose(
        `TTS: skipping long text (${textForAudio.length} > ${maxLength}), summarization disabled.`,
      );
      return params.payload;
    }

    const openaiKey = resolveTtsApiKey(config, "openai");
    if (!openaiKey) {
      logVerbose("TTS: skipping summarization - OpenAI key missing.");
      return params.payload;
    }

    try {
      const summary = await summarizeText(textForAudio, maxLength, openaiKey, config.timeoutMs);
      textForAudio = summary.summary;
      wasSummarized = true;
      if (textForAudio.length > config.maxTextLength) {
        logVerbose(
          `TTS: summary exceeded hard limit (${textForAudio.length} > ${config.maxTextLength}); truncating.`,
        );
        textForAudio = `${textForAudio.slice(0, config.maxTextLength - 3)}...`;
      }
    } catch (err) {
      const error = err as Error;
      logVerbose(`TTS: summarization failed: ${error.message}`);
      return params.payload;
    }
  }

  const ttsStart = Date.now();
  const result = await textToSpeech({
    text: textForAudio,
    cfg: params.cfg,
    prefsPath,
    channel: params.channel,
  });

  if (result.success && result.audioPath) {
    lastTtsAttempt = {
      timestamp: Date.now(),
      success: true,
      textLength: text.length,
      summarized: wasSummarized,
      provider: result.provider,
      latencyMs: result.latencyMs,
    };

    const channelId = resolveChannelId(params.channel);
    const shouldVoice = channelId === "telegram" && result.voiceCompatible === true;

    return {
      ...params.payload,
      mediaUrl: result.audioPath,
      audioAsVoice: shouldVoice || params.payload.audioAsVoice,
    };
  }

  lastTtsAttempt = {
    timestamp: Date.now(),
    success: false,
    textLength: text.length,
    summarized: wasSummarized,
    error: result.error,
  };

  const latency = Date.now() - ttsStart;
  logVerbose(`TTS: conversion failed after ${latency}ms (${result.error ?? "unknown"}).`);
  return params.payload;
}

export const _test = {
  isValidVoiceId,
  isValidOpenAIVoice,
  isValidOpenAIModel,
  OPENAI_TTS_MODELS,
  OPENAI_TTS_VOICES,
  summarizeText,
  resolveOutputFormat,
};

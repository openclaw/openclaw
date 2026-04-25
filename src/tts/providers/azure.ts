import type { SpeechProviderPlugin } from "../../plugins/types.js";
import type { SpeechVoiceOption } from "../provider-types.js";

// Only define once - shared with tts.ts for consistency
const DEFAULT_AZURE_OUTPUT_FORMAT = "audio-24khz-48kbitrate-mono-mp3";
const DEFAULT_TIMEOUT_MS = 30000;

type AzureVoiceListEntry = {
  Name?: string;
  DisplayName?: string;
  LocalName?: string;
  ShortName?: string;
  Gender?: string;
  Locale?: string;
  VoiceType?: string;
  Status?: string;
};

function normalizeAzureBaseUrl(baseUrl: string | undefined): string {
  const trimmed = baseUrl?.trim();
  if (!trimmed) {
    return "https://eastus.tts.speech.microsoft.com";
  }
  return trimmed.replace(/\/+$/, "");
}

function getFileExtension(outputFormat: string): string {
  if (outputFormat.includes("mp3")) return ".mp3";
  if (outputFormat.includes("wav") || outputFormat.includes("riff") || outputFormat.includes("pcm")) return ".wav";
  if (outputFormat.includes("ogg")) return ".ogg";
  if (outputFormat.includes("webm")) return ".webm";
  return ".mp3"; // default to mp3
}

function isVoiceCompatibleFormat(outputFormat: string): boolean {
  // Azure MP3 and opus formats are voice-note compatible
  return outputFormat.includes("mp3") || outputFormat.includes("opus");
}

export async function listAzureVoices(params: {
  apiKey: string;
  region?: string;
  baseUrl?: string;
  timeoutMs?: number;
}): Promise<SpeechVoiceOption[]> {
  const region = params.region || "eastus";
  const timeout = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // Use baseUrl if provided, otherwise derive from region
  const url = params.baseUrl
    ? `${normalizeAzureBaseUrl(params.baseUrl)}/cognitiveservices/voices/list`
    : `https://${region}.tts.speech.microsoft.com/cognitiveservices/voices/list`;

  const response = await fetch(url, {
    headers: {
      "Ocp-Apim-Subscription-Key": params.apiKey,
    },
    signal: AbortSignal.timeout(timeout),
  });

  if (!response.ok) {
    throw new Error(`Azure voices API error (${response.status})`);
  }

  const voices = (await response.json()) as AzureVoiceListEntry[];
  // Filter deprecated voices BEFORE mapping (Status field is available here)
  return Array.isArray(voices)
    ? voices
        .filter((voice) => voice.Status !== "Deprecated")
        .map((voice) => ({
          id: voice.ShortName?.trim() ?? "",
          name: voice.DisplayName?.trim() || voice.ShortName?.trim() || undefined,
          category: voice.VoiceType?.trim() || undefined,
          locale: voice.Locale?.trim() || undefined,
          gender: voice.Gender?.trim() || undefined,
        }))
        .filter((voice) => voice.id.length > 0)
    : [];
}

function escapeXml(str: string | undefined): string {
  if (!str) return "";
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function buildAzureSSML(text: string, voice: string, lang?: string): string {
  const escapedText = escapeXml(text);
  const escapedVoice = escapeXml(voice);
  const escapedLang = escapeXml(lang);

  return `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='${escapedLang || "en-US"}'><voice name='${escapedVoice}'>${escapedText}</voice></speak>`;
}

export function buildAzureSpeechProvider(): SpeechProviderPlugin {
  return {
    id: "azure",
    label: "Azure Speech",
    aliases: ["azure-tts"],
    listVoices: async (req) => {
      // baseUrl comes from the request, not from config
      const baseUrl = req.baseUrl ?? (req.providerConfig as Record<string, unknown>)?.baseUrl as string | undefined;
      const timeout = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const apiKey =
        req.apiKey ||
        ((req.providerConfig as Record<string, unknown>)?.apiKey as string) ||
        process.env.AZURE_SPEECH_API_KEY;
      if (!apiKey) {
        throw new Error("Azure Speech API key missing");
      }
      return listAzureVoices({
        apiKey,
        region: ((req.providerConfig as Record<string, unknown>)?.region as string) || process.env.AZURE_SPEECH_REGION,
        baseUrl,
        timeoutMs: timeout,
      });
    },
    isConfigured: ({ providerConfig }) =>
      Boolean(
        (providerConfig?.apiKey || process.env.AZURE_SPEECH_API_KEY) &&
        providerConfig?.voice, // Require voice to be set - API key alone is not enough
      ),
    synthesize: async (req) => {
      const apiKey =
        ((req.providerConfig as Record<string, unknown>)?.apiKey as string) ||
        process.env.AZURE_SPEECH_API_KEY;
      if (!apiKey) {
        throw new Error("Azure Speech API key missing");
      }

      const region =
        ((req.providerConfig as Record<string, unknown>)?.region as string) ||
        process.env.AZURE_SPEECH_REGION ||
        "eastus";
      const baseUrl = (req.providerConfig as Record<string, unknown>)?.baseUrl as string | undefined;
      // Use baseUrl if provided, otherwise derive from region
      const endpoint = baseUrl
        ? `${normalizeAzureBaseUrl(baseUrl)}/cognitiveservices/v1`
        : `https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`;

      // Apply directive overrides if provided
      const azureOverride = (req.providerOverrides as Record<string, unknown>)?.azure as Record<string, unknown> | undefined;
      const voice =
        (azureOverride?.voice as string) ||
        ((req.providerConfig as Record<string, unknown>)?.voice as string);
      const lang =
        (azureOverride?.lang as string) ||
        ((req.providerConfig as Record<string, unknown>)?.lang as string);
      const outputFormat =
        (azureOverride?.outputFormat as string) ||
        ((req.providerConfig as Record<string, unknown>)?.outputFormat as string) ||
        DEFAULT_AZURE_OUTPUT_FORMAT;

      if (!voice) {
        throw new Error(
          "Azure voice not configured. Set voice in config or use [[tts:azure_voice=zh-HK-HiuMaanNeural]] directive",
        );
      }

      // Use timeout from request (which comes from config), directive, or default
      const timeoutMs = req.timeoutMs;

      const ssml = buildAzureSSML(req.text, voice, lang);

      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Ocp-Apim-Subscription-Key": apiKey,
          "Content-Type": "application/ssml+xml",
          "X-Microsoft-OutputFormat": outputFormat,
        },
        body: ssml,
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!response.ok) {
        throw new Error(`Azure TTS failed: ${response.status} ${response.statusText}`);
      }

      const audioBuffer = await response.arrayBuffer();
      return {
        audioBuffer: Buffer.from(audioBuffer),
        outputFormat,
        fileExtension: getFileExtension(outputFormat),
        voiceCompatible: isVoiceCompatibleFormat(outputFormat),
      };
    },
  };
}
import type { SpeechProviderPlugin } from "../../plugins/types.js";
import type { SpeechVoiceOption } from "../provider-types.js";

const DEFAULT_AZURE_OUTPUT_FORMAT = "audio-24khz-48kbitrate-mono-mp3";

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

export async function listAzureVoices(params: {
  apiKey: string;
  region?: string;
  baseUrl?: string;
}): Promise<SpeechVoiceOption[]> {
  const region = params.region || "eastus";
  // Use baseUrl if provided, otherwise derive from region
  const url = params.baseUrl
    ? `${normalizeAzureBaseUrl(params.baseUrl)}/cognitiveservices/voices/list`
    : `https://${region}.tts.speech.microsoft.com/cognitiveservices/voices/list`;

  const response = await fetch(url, {
    headers: {
      "Ocp-Apim-Subscription-Key": params.apiKey,
    },
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

function buildAzureSSML(text: string, voice: string, lang?: string): string {
  const escapedText = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

  return `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='${lang || "en-US"}'><voice name='${voice}'>${escapedText}</voice></speak>`;
}

export function buildAzureSpeechProvider(): SpeechProviderPlugin {
  return {
    id: "azure",
    label: "Azure Speech",
    aliases: ["azure-tts"],
    listVoices: async (req) => {
      const apiKey =
        req.apiKey ||
        (req.config as any)?.azure?.apiKey ||
        process.env.AZURE_SPEECH_API_KEY;
      if (!apiKey) {
        throw new Error("Azure Speech API key missing");
      }
      return listAzureVoices({
        apiKey,
        region: (req.config as any)?.azure?.region || process.env.AZURE_SPEECH_REGION,
        baseUrl: (req.config as any)?.azure?.baseUrl,
      });
    },
    isConfigured: ({ config }) =>
      Boolean(
        (config as any)?.azure?.apiKey ||
          process.env.AZURE_SPEECH_API_KEY,
      ),
    synthesize: async (req) => {
      const apiKey =
        (req.config as any)?.azure?.apiKey || process.env.AZURE_SPEECH_API_KEY;
      if (!apiKey) {
        throw new Error("Azure Speech API key missing");
      }

      const region = (req.config as any)?.azure?.region || process.env.AZURE_SPEECH_REGION || "eastus";
      const baseUrl = (req.config as any)?.azure?.baseUrl;
      // Use baseUrl if provided, otherwise derive from region
      const endpoint = baseUrl
        ? `${normalizeAzureBaseUrl(baseUrl)}/cognitiveservices/v1`
        : `https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`;

      const voice = (req.config as any)?.azure?.voice;
      const lang = (req.config as any)?.azure?.lang;
      const outputFormat =
        (req.config as any)?.azure?.outputFormat ??
        DEFAULT_AZURE_OUTPUT_FORMAT;

      if (!voice) {
        throw new Error("Azure voice not configured");
      }

      const ssml = buildAzureSSML(req.text, voice, lang);

      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Ocp-Apim-Subscription-Key": apiKey,
          "Content-Type": "application/ssml+xml",
          "X-Microsoft-OutputFormat": outputFormat,
        },
        body: ssml,
        signal: AbortSignal.timeout((req.config as any)?.azure?.timeoutMs ?? 30000),
      });

      if (!response.ok) {
        throw new Error(`Azure TTS failed: ${response.status} ${response.statusText}`);
      }

      const audioBuffer = await response.arrayBuffer();
      return {
        audioBuffer: Buffer.from(audioBuffer),
        outputFormat,
        fileExtension: outputFormat.includes("mp3") ? ".mp3" : ".wav",
        voiceCompatible: true,
      };
    },
  };
}

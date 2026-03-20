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
  const base = normalizeAzureBaseUrl(params.baseUrl);
  const region = params.region || "eastus";
  const url = `https://${region}.tts.speech.microsoft.com/cognitiveservices/voices/list`;

  const response = await fetch(url, {
    headers: {
      "Ocp-Apim-Subscription-Key": params.apiKey,
    },
  });

  if (!response.ok) {
    throw new Error(`Azure voices API error (${response.status})`);
  }

  const voices = (await response.json()) as AzureVoiceListEntry[];
  return Array.isArray(voices)
    ? voices
        .map((voice) => ({
          id: voice.ShortName?.trim() ?? "",
          name: voice.DisplayName?.trim() || voice.ShortName?.trim() || undefined,
          category: voice.VoiceType?.trim() || undefined,
          locale: voice.Locale?.trim() || undefined,
          gender: voice.Gender?.trim() || undefined,
        }))
        .filter((voice) => voice.id.length > 0 && voice.Status !== "Deprecated")
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
        req.config?.azure?.apiKey ||
        process.env.AZURE_SPEECH_API_KEY;
      if (!apiKey) {
        throw new Error("Azure Speech API key missing");
      }
      return listAzureVoices({
        apiKey,
        region: req.config?.azure?.region || process.env.AZURE_SPEECH_REGION,
        baseUrl: req.config?.azure?.baseUrl,
      });
    },
    isConfigured: ({ config }) =>
      Boolean(
        config.azure?.apiKey ||
          process.env.AZURE_SPEECH_API_KEY,
      ),
    synthesize: async (req) => {
      const apiKey =
        req.config.azure?.apiKey || process.env.AZURE_SPEECH_API_KEY;
      if (!apiKey) {
        throw new Error("Azure Speech API key missing");
      }

      const region = req.config?.azure?.region || process.env.AZURE_SPEECH_REGION || "eastus";
      const baseUrl = normalizeAzureBaseUrl(req.config?.azure?.baseUrl);
      const voice = req.overrides?.azure?.voice ?? req.config?.azure?.voice;
      const lang = req.overrides?.azure?.lang ?? req.config?.azure?.lang;
      const outputFormat =
        req.overrides?.azure?.outputFormat ??
        req.config?.azure?.outputFormat ??
        DEFAULT_AZURE_OUTPUT_FORMAT;

      if (!voice) {
        throw new Error("Azure voice not configured");
      }

      const endpoint = `${baseUrl}/cognitiveservices/v1`;
      const ssml = buildAzureSSML(req.text, voice, lang);

      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Ocp-Apim-Subscription-Key": apiKey,
          "Content-Type": "application/ssml+xml",
          "X-Microsoft-OutputFormat": outputFormat,
        },
        body: ssml,
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

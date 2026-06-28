import type { OpenAIAudioEndpointTrust } from "../agents/model-auth.js";
import type { MediaUnderstandingCapability } from "./types.js";

// Shared API contract id for OpenAI-compatible /audio/transcriptions requests.
export const OPENAI_AUDIO_TRANSCRIPTIONS_API = "openai-audio-transcriptions";

export function resolveOpenAiAudioAuthModelApi(params: {
  capability: MediaUnderstandingCapability;
  providerId: string;
}): string | undefined {
  if (params.capability === "audio" && params.providerId.trim().toLowerCase() === "openai") {
    return OPENAI_AUDIO_TRANSCRIPTIONS_API;
  }
  return undefined;
}

function isTrustedOpenAIPublicAudioBaseUrl(baseUrl: string | undefined): boolean {
  if (!baseUrl?.trim()) {
    return true;
  }
  try {
    const url = new URL(baseUrl.trim());
    if (url.protocol !== "https:") {
      return false;
    }
    const hostname = url.hostname.toLowerCase().replace(/\.+$/u, "");
    if (hostname !== "api.openai.com" && !hostname.endsWith(".api.openai.com")) {
      return false;
    }
    const pathname = url.pathname.replace(/\/+$/u, "");
    return pathname === "" || pathname === "/v1";
  } catch {
    return false;
  }
}

export function resolveOpenAiAudioAuthEndpointTrust(params: {
  capability: MediaUnderstandingCapability;
  providerId: string;
  baseUrl?: string;
}): OpenAIAudioEndpointTrust | undefined {
  if (resolveOpenAiAudioAuthModelApi(params) !== OPENAI_AUDIO_TRANSCRIPTIONS_API) {
    return undefined;
  }
  return isTrustedOpenAIPublicAudioBaseUrl(params.baseUrl)
    ? "native-openai"
    : "custom-openai-compatible";
}

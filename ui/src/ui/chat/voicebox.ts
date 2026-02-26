export type VoiceboxProfile = {
  id: string;
  name: string;
  language: string;
};

type VoiceboxModelSize = "0.6B" | "1.7B";

type GenerateStreamRequest = {
  profile_id: string;
  text: string;
  language?: string;
  model_size?: VoiceboxModelSize;
  max_new_tokens?: number;
};

type GenerateResponse = {
  id?: string;
};

let activeAudio: HTMLAudioElement | null = null;
let activeUrl: string | null = null;
let activeController: AbortController | null = null;
let streamEndpointSupportByBaseUrl = new Map<string, boolean>();

const DEFAULT_MODEL_SIZE: VoiceboxModelSize = "0.6B";
const DEFAULT_MAX_NEW_TOKENS = 384;
const MAX_SPOKEN_CHARS = 320;

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function isLikelyAudioContentType(contentType: string): boolean {
  const lower = contentType.toLowerCase();
  if (!lower) {
    return true;
  }
  if (
    lower.includes("application/json") ||
    lower.includes("text/plain") ||
    lower.includes("text/html")
  ) {
    return false;
  }
  return lower.startsWith("audio/") || lower.includes("application/octet-stream");
}

export function normalizeVoiceboxBaseUrl(value: string): string {
  const trimmed = value.trim();
  return trimTrailingSlash(trimmed || "http://127.0.0.1:17493");
}

export async function listVoiceboxProfiles(baseUrl: string): Promise<VoiceboxProfile[]> {
  const endpoint = `${normalizeVoiceboxBaseUrl(baseUrl)}/profiles`;
  const response = await fetch(endpoint, { method: "GET" });
  if (!response.ok) {
    throw new Error(`Voicebox profiles failed: HTTP ${response.status}`);
  }
  const raw = (await response.json()) as Array<Record<string, unknown>>;
  if (!Array.isArray(raw)) {
    return [];
  }
  const profiles = raw
    .map((item) => {
      const id = typeof item.id === "string" ? item.id.trim() : "";
      const name = typeof item.name === "string" ? item.name.trim() : "";
      const language = typeof item.language === "string" ? item.language.trim() : "en";
      if (!id || !name) {
        return null;
      }
      return { id, name, language };
    })
    .filter((item): item is VoiceboxProfile => item !== null);

  profiles.sort((a, b) => a.name.localeCompare(b.name));
  return profiles;
}

export function stopVoiceboxPlayback() {
  if (activeController) {
    activeController.abort();
    activeController = null;
  }
  if (activeAudio) {
    activeAudio.pause();
    activeAudio.currentTime = 0;
    activeAudio = null;
  }
  if (activeUrl) {
    URL.revokeObjectURL(activeUrl);
    activeUrl = null;
  }
}

async function requestVoiceboxAudio(
  baseUrl: string,
  payload: GenerateStreamRequest,
  signal: AbortSignal,
): Promise<Blob> {
  const normalizedBaseUrl = normalizeVoiceboxBaseUrl(baseUrl);
  const streamSupported = streamEndpointSupportByBaseUrl.get(normalizedBaseUrl) !== false;
  if (streamSupported) {
    const streamEndpoint = `${normalizedBaseUrl}/generate/stream`;
    const streamResponse = await fetch(streamEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal,
    });
    if (streamResponse.ok) {
      const streamContentType = streamResponse.headers.get("content-type") || "";
      if (isLikelyAudioContentType(streamContentType)) {
        streamEndpointSupportByBaseUrl.set(normalizedBaseUrl, true);
        const streamBlob = await streamResponse.blob();
        return new Blob([streamBlob], { type: "audio/wav" });
      }
      // Some Voicebox builds return JSON/text from /generate/stream.
      // Switch to /generate + /audio/{id} fallback for deterministic audio payloads.
      streamEndpointSupportByBaseUrl.set(normalizedBaseUrl, false);
    } else {
      streamEndpointSupportByBaseUrl.set(normalizedBaseUrl, false);
    }
  }

  const generateEndpoint = `${normalizedBaseUrl}/generate`;
  const generateResponse = await fetch(generateEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal,
  });
  if (!generateResponse.ok) {
    throw new Error(`Voicebox generation failed: HTTP ${generateResponse.status}`);
  }
  const generation = (await generateResponse.json()) as GenerateResponse;
  const generationId = typeof generation.id === "string" ? generation.id.trim() : "";
  if (!generationId) {
    throw new Error("Voicebox generation failed: missing generation id");
  }

  const audioEndpoint = `${normalizedBaseUrl}/audio/${encodeURIComponent(generationId)}`;
  const audioResponse = await fetch(audioEndpoint, {
    method: "GET",
    signal,
  });
  if (!audioResponse.ok) {
    throw new Error(`Voicebox audio download failed: HTTP ${audioResponse.status}`);
  }
  const audioContentType = (audioResponse.headers.get("content-type") || "").toLowerCase();
  if (!isLikelyAudioContentType(audioContentType)) {
    const detail = (await audioResponse.text()).slice(0, 300);
    throw new Error(`Voicebox audio payload invalid (${audioContentType}): ${detail}`);
  }
  const bytes = await audioResponse.arrayBuffer();
  return new Blob([bytes], { type: "audio/wav" });
}

export async function synthesizeVoiceboxAndPlay(params: {
  baseUrl: string;
  profileId: string;
  text: string;
  language?: string;
}): Promise<boolean> {
  const text = params.text.trim().slice(0, MAX_SPOKEN_CHARS);
  const profileId = params.profileId.trim();
  if (!text || !profileId) {
    return false;
  }

  stopVoiceboxPlayback();
  const controller = new AbortController();
  activeController = controller;
  const audioBlob = await requestVoiceboxAudio(
    params.baseUrl,
    {
      profile_id: profileId,
      text,
      language: params.language ?? "en",
      model_size: DEFAULT_MODEL_SIZE,
      max_new_tokens: DEFAULT_MAX_NEW_TOKENS,
    },
    controller.signal,
  );

  if (controller.signal.aborted) {
    return false;
  }

  const objectUrl = URL.createObjectURL(audioBlob);
  const audio = new Audio(objectUrl);
  activeUrl = objectUrl;
  activeAudio = audio;
  activeController = null;

  const cleanup = () => {
    if (activeAudio === audio) {
      activeAudio = null;
    }
    if (activeUrl === objectUrl) {
      URL.revokeObjectURL(objectUrl);
      activeUrl = null;
    }
  };

  audio.addEventListener("ended", cleanup, { once: true });
  audio.addEventListener("error", cleanup, { once: true });
  await audio.play();
  return true;
}

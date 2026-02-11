import type { AudioTranscriptionRequest, AudioTranscriptionResult } from "../../types.js";
import { fetchWithTimeoutGuarded, normalizeBaseUrl, readErrorResponse } from "../shared.js";

export const DEFAULT_ASSEMBLYAI_BASE_URL = "https://api.assemblyai.com/v2";
export const DEFAULT_ASSEMBLYAI_MODEL = "best";

/** Polling interval starts at 1s, backs off up to 3s. */
const POLL_INITIAL_MS = 1_000;
const POLL_MAX_MS = 3_000;
const POLL_BACKOFF = 1.5;

function resolveModel(model?: string): string {
  const trimmed = model?.trim();
  return trimmed || DEFAULT_ASSEMBLYAI_MODEL;
}

type UploadResponse = { upload_url: string };

type TranscriptSubmitResponse = {
  id: string;
  status: "queued" | "processing" | "completed" | "error";
  text?: string | null;
  error?: string;
  speech_model?: string | null;
};

/**
 * Upload audio buffer to AssemblyAI and get a hosted URL.
 * AssemblyAI requires audio to be hosted; this step uploads it to their servers.
 */
async function uploadAudio(params: {
  buffer: Buffer;
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
  fetchFn: typeof fetch;
  headers?: Record<string, string>;
}): Promise<string> {
  const url = `${params.baseUrl}/upload`;

  const headers = new Headers(params.headers);
  headers.set("authorization", params.apiKey);
  if (!headers.has("content-type")) {
    headers.set("content-type", "application/octet-stream");
  }

  const { response: res, release } = await fetchWithTimeoutGuarded(
    url,
    { method: "POST", headers, body: new Uint8Array(params.buffer) },
    params.timeoutMs,
    params.fetchFn,
  );

  try {
    if (!res.ok) {
      const detail = await readErrorResponse(res);
      throw new Error(
        `AssemblyAI upload failed (HTTP ${res.status})${detail ? `: ${detail}` : ""}`,
      );
    }
    const payload = (await res.json()) as UploadResponse;
    if (!payload.upload_url) {
      throw new Error("AssemblyAI upload response missing upload_url");
    }
    return payload.upload_url;
  } finally {
    await release();
  }
}

/**
 * Submit a transcription job and return the transcript ID.
 */
async function submitTranscript(params: {
  audioUrl: string;
  model: string;
  language?: string;
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
  fetchFn: typeof fetch;
  headers?: Record<string, string>;
  query?: Record<string, string | number | boolean>;
}): Promise<string> {
  const url = `${params.baseUrl}/transcript`;

  const headers = new Headers(params.headers);
  headers.set("authorization", params.apiKey);
  headers.set("content-type", "application/json");

  const body: Record<string, unknown> = {
    audio_url: params.audioUrl,
  };

  // Map model to speech_model (AssemblyAI uses "best" and "nano" as presets)
  if (params.model && params.model !== "best") {
    body.speech_model = params.model;
  }
  if (params.language?.trim()) {
    body.language_code = params.language.trim();
  }
  // Pass through any extra query params as top-level fields
  if (params.query) {
    for (const [key, value] of Object.entries(params.query)) {
      if (value !== undefined) {
        body[key] = value;
      }
    }
  }

  const { response: res, release } = await fetchWithTimeoutGuarded(
    url,
    { method: "POST", headers, body: JSON.stringify(body) },
    params.timeoutMs,
    params.fetchFn,
  );

  try {
    if (!res.ok) {
      const detail = await readErrorResponse(res);
      throw new Error(
        `AssemblyAI transcript submit failed (HTTP ${res.status})${detail ? `: ${detail}` : ""}`,
      );
    }
    const payload = (await res.json()) as TranscriptSubmitResponse;
    if (!payload.id) {
      throw new Error("AssemblyAI transcript submit response missing id");
    }
    if (payload.status === "error") {
      throw new Error(`AssemblyAI transcription error: ${payload.error ?? "unknown"}`);
    }
    return payload.id;
  } finally {
    await release();
  }
}

/**
 * Poll for transcript completion with exponential backoff.
 * Returns the transcript text once status is "completed".
 */
async function pollTranscript(params: {
  transcriptId: string;
  baseUrl: string;
  apiKey: string;
  deadlineMs: number;
  fetchFn: typeof fetch;
  headers?: Record<string, string>;
}): Promise<{ text: string; speechModel?: string }> {
  const url = `${params.baseUrl}/transcript/${params.transcriptId}`;
  const start = Date.now();
  let interval = POLL_INITIAL_MS;

  while (true) {
    const elapsed = Date.now() - start;
    if (elapsed >= params.deadlineMs) {
      throw new Error(
        `AssemblyAI transcription timed out after ${Math.round(elapsed / 1000)}s (id: ${params.transcriptId})`,
      );
    }

    const headers = new Headers(params.headers);
    headers.set("authorization", params.apiKey);

    const remaining = params.deadlineMs - elapsed;
    const { response: res, release } = await fetchWithTimeoutGuarded(
      url,
      { method: "GET", headers },
      Math.min(remaining, 15_000),
      params.fetchFn,
    );

    let payload: TranscriptSubmitResponse;
    try {
      if (!res.ok) {
        const detail = await readErrorResponse(res);
        throw new Error(
          `AssemblyAI poll failed (HTTP ${res.status})${detail ? `: ${detail}` : ""}`,
        );
      }
      payload = (await res.json()) as TranscriptSubmitResponse;
    } finally {
      await release();
    }

    if (payload.status === "completed") {
      const text = payload.text?.trim();
      if (!text) {
        throw new Error("AssemblyAI transcription completed but returned empty text");
      }
      return { text, speechModel: payload.speech_model ?? undefined };
    }

    if (payload.status === "error") {
      throw new Error(`AssemblyAI transcription failed: ${payload.error ?? "unknown error"}`);
    }

    // Still queued/processing — wait before next poll
    await new Promise((resolve) => setTimeout(resolve, interval));
    interval = Math.min(interval * POLL_BACKOFF, POLL_MAX_MS);
  }
}

/**
 * Transcribe audio via AssemblyAI's async REST API.
 *
 * Flow: upload audio → submit transcript job → poll for completion.
 * This is a multi-step provider (unlike Deepgram/OpenAI which are single-request).
 */
export async function transcribeAssemblyAiAudio(
  params: AudioTranscriptionRequest,
): Promise<AudioTranscriptionResult> {
  const fetchFn = params.fetchFn ?? fetch;
  const baseUrl = normalizeBaseUrl(params.baseUrl, DEFAULT_ASSEMBLYAI_BASE_URL);
  const model = resolveModel(params.model);
  const totalTimeout = params.timeoutMs;
  const start = Date.now();

  // Step 1: Upload audio buffer
  const uploadUrl = await uploadAudio({
    buffer: params.buffer,
    baseUrl,
    apiKey: params.apiKey,
    timeoutMs: Math.min(totalTimeout, 30_000),
    fetchFn,
    headers: params.headers,
  });

  // Step 2: Submit transcription job
  const elapsed1 = Date.now() - start;
  const transcriptId = await submitTranscript({
    audioUrl: uploadUrl,
    model,
    language: params.language,
    baseUrl,
    apiKey: params.apiKey,
    timeoutMs: Math.min(totalTimeout - elapsed1, 15_000),
    fetchFn,
    headers: params.headers,
    query: params.query,
  });

  // Step 3: Poll for completion
  const elapsed2 = Date.now() - start;
  const result = await pollTranscript({
    transcriptId,
    baseUrl,
    apiKey: params.apiKey,
    deadlineMs: totalTimeout - elapsed2,
    fetchFn,
    headers: params.headers,
  });

  return { text: result.text, model: result.speechModel ?? model };
}

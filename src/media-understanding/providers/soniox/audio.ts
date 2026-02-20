import type { AudioTranscriptionRequest, AudioTranscriptionResult } from "../../types.js";
import { fetchWithTimeoutGuarded, normalizeBaseUrl, readErrorResponse } from "../shared.js";

export const DEFAULT_SONIOX_AUDIO_BASE_URL = "https://api.soniox.com/v1";
export const DEFAULT_SONIOX_AUDIO_MODEL = "stt-async-v4";
const POLL_INTERVAL_MS = 2_000;

function resolveModel(model?: string): string {
  const trimmed = model?.trim();
  return trimmed || DEFAULT_SONIOX_AUDIO_MODEL;
}

type SonioxFileResponse = {
  file_id?: string;
  id?: string;
};

type SonioxTranscriptionResponse = {
  id?: string;
  transcription_id?: string;
  status?: string;
  error_type?: string;
  error_message?: string;
};

type SonioxTranscriptWord = {
  text?: string;
};

type SonioxTranscriptResponse = {
  text?: string;
  transcript?: string;
  words?: SonioxTranscriptWord[];
};

/**
 * Build a multipart/form-data body for file upload.
 */
function buildMultipartBody(
  fileName: string,
  buffer: Uint8Array,
  mime: string,
): { body: Uint8Array; boundary: string } {
  const boundary = `----SonioxBoundary${Date.now()}${Math.random().toString(36).slice(2)}`;
  const encoder = new TextEncoder();

  const safeFileName = fileName.replace(/["\\]/g, "\\$&").replace(/\r\n|\r|\n/g, "_");
  const header = encoder.encode(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${safeFileName}"\r\n` +
      `Content-Type: ${mime}\r\n` +
      `\r\n`,
  );
  const footer = encoder.encode(`\r\n--${boundary}--\r\n`);

  const body = new Uint8Array(header.length + buffer.length + footer.length);
  body.set(header, 0);
  body.set(buffer, header.length);
  body.set(footer, header.length + buffer.length);

  return { body, boundary };
}

/**
 * Upload an audio file to Soniox and return the file_id.
 */
async function uploadFile(params: {
  buffer: Buffer;
  fileName: string;
  mime: string;
  apiKey: string;
  baseUrl: string;
  timeoutMs: number;
  fetchFn: typeof fetch;
}): Promise<string> {
  const { body, boundary } = buildMultipartBody(
    params.fileName,
    new Uint8Array(params.buffer),
    params.mime,
  );

  const headers = new Headers();
  headers.set("authorization", `Bearer ${params.apiKey}`);
  headers.set("content-type", `multipart/form-data; boundary=${boundary}`);

  const { response: res, release } = await fetchWithTimeoutGuarded(
    `${params.baseUrl}/files`,
    { method: "POST", headers, body: Buffer.from(body) },
    params.timeoutMs,
    params.fetchFn,
  );

  try {
    if (!res.ok) {
      const detail = await readErrorResponse(res);
      const suffix = detail ? `: ${detail}` : "";
      throw new Error(`Soniox file upload failed (HTTP ${res.status})${suffix}`);
    }

    const payload = (await res.json()) as SonioxFileResponse;
    const fileId = payload.file_id ?? payload.id;
    if (!fileId) {
      throw new Error("Soniox file upload response missing file_id");
    }
    return fileId;
  } finally {
    await release();
  }
}

/**
 * Create a transcription job and return the transcription ID.
 */
async function createTranscription(params: {
  fileId: string;
  model: string;
  language?: string;
  apiKey: string;
  baseUrl: string;
  timeoutMs: number;
  fetchFn: typeof fetch;
}): Promise<string> {
  const payload: Record<string, unknown> = {
    model: params.model,
    file_id: params.fileId,
    enable_speaker_diarization: false,
  };
  if (params.language?.trim()) {
    payload.language_hints = [params.language.trim()];
  }

  const headers = new Headers();
  headers.set("authorization", `Bearer ${params.apiKey}`);
  headers.set("content-type", "application/json");

  const { response: res, release } = await fetchWithTimeoutGuarded(
    `${params.baseUrl}/transcriptions`,
    { method: "POST", headers, body: Buffer.from(JSON.stringify(payload)) },
    params.timeoutMs,
    params.fetchFn,
  );

  try {
    if (!res.ok) {
      const detail = await readErrorResponse(res);
      const suffix = detail ? `: ${detail}` : "";
      throw new Error(`Soniox transcription creation failed (HTTP ${res.status})${suffix}`);
    }

    const result = (await res.json()) as SonioxTranscriptionResponse;
    const transcriptionId = result.transcription_id ?? result.id;
    if (!transcriptionId) {
      throw new Error("Soniox transcription response missing transcription_id");
    }
    return transcriptionId;
  } finally {
    await release();
  }
}

/**
 * Poll a transcription job until it completes or fails.
 */
async function pollTranscription(params: {
  transcriptionId: string;
  apiKey: string;
  baseUrl: string;
  timeoutMs: number;
  fetchFn: typeof fetch;
}): Promise<void> {
  const deadline = Date.now() + params.timeoutMs;

  while (Date.now() < deadline) {
    const headers = new Headers();
    headers.set("authorization", `Bearer ${params.apiKey}`);

    const { response: res, release } = await fetchWithTimeoutGuarded(
      `${params.baseUrl}/transcriptions/${params.transcriptionId}`,
      { method: "GET", headers },
      Math.min(30_000, deadline - Date.now()),
      params.fetchFn,
    );

    let result: SonioxTranscriptionResponse;
    try {
      if (!res.ok) {
        const detail = await readErrorResponse(res);
        const suffix = detail ? `: ${detail}` : "";
        throw new Error(`Soniox poll failed (HTTP ${res.status})${suffix}`);
      }
      result = (await res.json()) as SonioxTranscriptionResponse;
    } finally {
      await release();
    }

    if (result.status === "completed") {
      return;
    }
    if (result.status === "error" || result.status === "failed") {
      const errMsg = result.error_message ?? result.error_type ?? "unknown error";
      throw new Error(`Soniox transcription failed: ${errMsg}`);
    }

    // Wait before next poll
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  throw new Error("Soniox transcription timed out while polling");
}

/**
 * Retrieve the transcript text for a completed transcription.
 */
async function getTranscript(params: {
  transcriptionId: string;
  apiKey: string;
  baseUrl: string;
  timeoutMs: number;
  fetchFn: typeof fetch;
}): Promise<string> {
  const headers = new Headers();
  headers.set("authorization", `Bearer ${params.apiKey}`);

  const { response: res, release } = await fetchWithTimeoutGuarded(
    `${params.baseUrl}/transcriptions/${params.transcriptionId}/transcript`,
    { method: "GET", headers },
    params.timeoutMs,
    params.fetchFn,
  );

  try {
    if (!res.ok) {
      const detail = await readErrorResponse(res);
      const suffix = detail ? `: ${detail}` : "";
      throw new Error(`Soniox transcript retrieval failed (HTTP ${res.status})${suffix}`);
    }

    const payload = (await res.json()) as SonioxTranscriptResponse;

    // Extract text - may be in different fields depending on API version
    let text = payload.text ?? payload.transcript;
    if (!text && Array.isArray(payload.words)) {
      text = payload.words.map((w) => w.text ?? "").join(" ");
    }
    if (!text?.trim()) {
      throw new Error("Soniox transcript response missing text");
    }
    return text.trim();
  } finally {
    await release();
  }
}

/**
 * Transcribe audio using Soniox async API.
 *
 * Workflow: upload file → create transcription → poll → get transcript
 */
export async function transcribeSonioxAudio(
  params: AudioTranscriptionRequest,
): Promise<AudioTranscriptionResult> {
  const fetchFn = params.fetchFn ?? fetch;
  const baseUrl = normalizeBaseUrl(params.baseUrl, DEFAULT_SONIOX_AUDIO_BASE_URL);
  const model = resolveModel(params.model);
  const mime = params.mime ?? "application/octet-stream";

  // Use a single deadline so total wall-clock time is bounded by timeoutMs
  const deadline = Date.now() + params.timeoutMs;
  const remaining = () => Math.max(1_000, deadline - Date.now());

  // Step 1: Upload file
  const fileId = await uploadFile({
    buffer: params.buffer,
    fileName: params.fileName,
    mime,
    apiKey: params.apiKey,
    baseUrl,
    timeoutMs: remaining(),
    fetchFn,
  });

  // Step 2: Create transcription job
  const transcriptionId = await createTranscription({
    fileId,
    model,
    language: params.language,
    apiKey: params.apiKey,
    baseUrl,
    timeoutMs: remaining(),
    fetchFn,
  });

  // Step 3: Poll until complete
  await pollTranscription({
    transcriptionId,
    apiKey: params.apiKey,
    baseUrl,
    timeoutMs: remaining(),
    fetchFn,
  });

  // Step 4: Get transcript
  const text = await getTranscript({
    transcriptionId,
    apiKey: params.apiKey,
    baseUrl,
    timeoutMs: remaining(),
    fetchFn,
  });

  return { text, model };
}

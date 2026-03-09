import type { AudioTranscriptionRequest, AudioTranscriptionResult } from "../../types.js";
import {
  assertOkOrThrowHttpError,
  fetchWithTimeoutGuarded,
  normalizeBaseUrl,
  postTranscriptionRequest,
  requireTranscriptionText,
} from "../shared.js";

export const DEFAULT_ASSEMBLYAI_BASE_URL = "https://api.assemblyai.com/v2";
export const DEFAULT_ASSEMBLYAI_MODEL = "best";

const POLL_INTERVAL_MS = 2_000;
const MAX_POLL_ATTEMPTS = 120; // 4 min max with 2s intervals

type UploadResponse = {
  upload_url?: string;
};

type TranscriptResponse = {
  id?: string;
  status?: "queued" | "processing" | "completed" | "error";
  text?: string;
  error?: string;
};

export async function transcribeAssemblyAIAudio(
  params: AudioTranscriptionRequest,
): Promise<AudioTranscriptionResult> {
  const fetchFn = params.fetchFn ?? fetch;
  const baseUrl = normalizeBaseUrl(params.baseUrl, DEFAULT_ASSEMBLYAI_BASE_URL);
  const allowPrivate = Boolean(params.baseUrl?.trim());
  const model = params.model?.trim() || DEFAULT_ASSEMBLYAI_MODEL;

  const authHeaders = new Headers(params.headers);
  if (!authHeaders.has("authorization")) {
    authHeaders.set("authorization", params.apiKey);
  }

  // Step 1: Upload audio binary
  const uploadHeaders = new Headers(authHeaders);
  uploadHeaders.set("content-type", "application/octet-stream");
  const { response: uploadRes, release: releaseUpload } = await postTranscriptionRequest({
    url: `${baseUrl}/upload`,
    headers: uploadHeaders,
    body: new Uint8Array(params.buffer),
    timeoutMs: params.timeoutMs,
    fetchFn,
    allowPrivateNetwork: allowPrivate,
  });
  let uploadData: UploadResponse;
  try {
    await assertOkOrThrowHttpError(uploadRes, "AssemblyAI upload");
    uploadData = (await uploadRes.json()) as UploadResponse;
  } finally {
    await releaseUpload();
  }
  if (!uploadData.upload_url) {
    throw new Error("AssemblyAI upload: missing upload_url in response");
  }

  // Step 2: Create transcript job
  const transcriptBody: Record<string, unknown> = { audio_url: uploadData.upload_url };
  if (params.language?.trim()) {
    transcriptBody.language_code = params.language.trim();
  }
  if (model !== "best") {
    transcriptBody.speech_model = model;
  }
  const createHeaders = new Headers(authHeaders);
  createHeaders.set("content-type", "application/json");
  const { response: createRes, release: releaseCreate } = await fetchWithTimeoutGuarded(
    `${baseUrl}/transcript`,
    { method: "POST", headers: createHeaders, body: JSON.stringify(transcriptBody) },
    params.timeoutMs,
    fetchFn,
    allowPrivate ? { ssrfPolicy: { allowPrivateNetwork: true } } : undefined,
  );
  let createData: TranscriptResponse;
  try {
    await assertOkOrThrowHttpError(createRes, "AssemblyAI create transcript");
    createData = (await createRes.json()) as TranscriptResponse;
  } finally {
    await releaseCreate();
  }
  if (!createData.id) {
    throw new Error("AssemblyAI create transcript: missing id in response");
  }

  // Step 3: Poll until completed or error
  const deadline = Date.now() + params.timeoutMs;
  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
    if (Date.now() >= deadline) {
      throw new Error(`AssemblyAI transcript timed out after ${params.timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));

    const remainingMs = Math.max(10_000, deadline - Date.now());
    const { response: pollRes, release: releasePoll } = await fetchWithTimeoutGuarded(
      `${baseUrl}/transcript/${createData.id}`,
      { method: "GET", headers: authHeaders },
      remainingMs,
      fetchFn,
      allowPrivate ? { ssrfPolicy: { allowPrivateNetwork: true } } : undefined,
    );
    let pollData: TranscriptResponse;
    try {
      await assertOkOrThrowHttpError(pollRes, "AssemblyAI poll transcript");
      pollData = (await pollRes.json()) as TranscriptResponse;
    } finally {
      await releasePoll();
    }

    if (pollData.status === "error") {
      throw new Error(`AssemblyAI transcript error: ${pollData.error ?? "unknown"}`);
    }
    if (pollData.status === "completed") {
      const text = requireTranscriptionText(pollData.text, "AssemblyAI returned empty transcript");
      return { text, model };
    }
  }

  throw new Error("AssemblyAI transcript: max poll attempts exceeded");
}

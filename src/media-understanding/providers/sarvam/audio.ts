import path from "node:path";
import type { AudioTranscriptionRequest, AudioTranscriptionResult } from "../../types.js";
import { fetchWithTimeoutGuarded, normalizeBaseUrl, readErrorResponse } from "../shared.js";

export const DEFAULT_SARVAM_AUDIO_BASE_URL = "https://api.sarvam.ai";
export const DEFAULT_SARVAM_AUDIO_MODEL = "saarika:v2.5";

type SarvamTimestamp = {
  word: string;
  start_time_seconds: number;
  end_time_seconds: number;
};

type SarvamDiarizedSegment = {
  transcript: string;
  start_time_seconds: number;
  end_time_seconds: number;
  speaker_id: string;
};

type SarvamTranscriptResponse = {
  transcript?: string;
  timestamps?: SarvamTimestamp[] | null;
  diarized_transcript?: {
    entries: SarvamDiarizedSegment[];
  } | null;
  language_code?: string | null;
};

export async function transcribeSarvamAudio(
  params: AudioTranscriptionRequest,
): Promise<AudioTranscriptionResult> {
  const fetchFn = params.fetchFn ?? fetch;
  const baseUrl = normalizeBaseUrl(params.baseUrl, DEFAULT_SARVAM_AUDIO_BASE_URL);
  const allowPrivate = Boolean(params.baseUrl?.trim());
  const url = `${baseUrl}/speech-to-text`;

  const form = new FormData();
  const bytes = new Uint8Array(params.buffer);
  const blob = new Blob([bytes], {
    type: params.mime ?? "application/octet-stream",
  });

  const fileName = params.fileName?.trim() ? path.basename(params.fileName.trim()) : "audio.wav";
  form.append("file", blob, fileName);

  // Model - default to saarika:v2.5
  const model = params.model?.trim() || DEFAULT_SARVAM_AUDIO_MODEL;
  form.append("model", model);

  // Language code - optional for saarika:v2.5, required for saarika:v1
  // Available: unknown, hi-IN, bn-IN, kn-IN, ml-IN, mr-IN, od-IN, pa-IN, ta-IN, te-IN, en-IN, gu-IN
  if (params.language?.trim()) {
    form.append("language_code", params.language.trim());
  }

  // Handle provider-specific options from query params
  if (params.query) {
    // with_timestamps - include word-level timestamps
    if (params.query.with_timestamps !== undefined) {
      form.append("with_timestamps", String(params.query.with_timestamps));
    }
    // with_diarization - enable speaker diarization
    if (params.query.with_diarization !== undefined) {
      form.append("with_diarization", String(params.query.with_diarization));
    }
    // num_speakers - number of speakers to detect (with diarization)
    if (params.query.num_speakers !== undefined) {
      form.append("num_speakers", String(params.query.num_speakers));
    }
    // input_audio_codec - required for PCM formats
    if (params.query.input_audio_codec !== undefined) {
      form.append("input_audio_codec", String(params.query.input_audio_codec));
    }
    // mode - only for saaras:v3 model (transcribe, translate, verbatim, translit, codemix)
    if (params.query.mode !== undefined) {
      form.append("mode", String(params.query.mode));
    }
  }

  const headers = new Headers(params.headers);
  // Sarvam uses api-subscription-key header for auth (NOT Bearer token)
  if (!headers.has("api-subscription-key")) {
    headers.set("api-subscription-key", params.apiKey);
  }
  // Note: Don't set content-type, FormData sets its own with boundary

  const { response: res, release } = await fetchWithTimeoutGuarded(
    url,
    {
      method: "POST",
      headers,
      body: form,
    },
    params.timeoutMs,
    fetchFn,
    allowPrivate ? { ssrfPolicy: { allowPrivateNetwork: true } } : undefined,
  );

  try {
    if (!res.ok) {
      const detail = await readErrorResponse(res);
      const suffix = detail ? `: ${detail}` : "";
      throw new Error(`Audio transcription failed (HTTP ${res.status})${suffix}`);
    }

    const payload = (await res.json()) as SarvamTranscriptResponse;
    let transcript = payload.transcript?.trim();

    // If no top-level transcript but diarized output exists, join segments
    if (!transcript && payload.diarized_transcript?.entries?.length) {
      transcript = payload.diarized_transcript.entries
        .map((e) => e.transcript)
        .filter(Boolean)
        .join(" ");
    }

    if (!transcript) {
      throw new Error("Audio transcription response missing transcript");
    }

    return { text: transcript, model };
  } finally {
    await release();
  }
}

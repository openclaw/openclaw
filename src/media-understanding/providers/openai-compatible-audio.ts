import path from "node:path";
import { extensionForMime } from "../../media/mime.js";
import type { AudioTranscriptionRequest, AudioTranscriptionResult } from "../types.js";
import {
  assertOkOrThrowHttpError,
  normalizeBaseUrl,
  postTranscriptionRequest,
  requireTranscriptionText,
} from "./shared.js";

type OpenAiCompatibleAudioParams = AudioTranscriptionRequest & {
  defaultBaseUrl: string;
  defaultModel: string;
};

function resolveModel(model: string | undefined, fallback: string): string {
  const trimmed = model?.trim();
  return trimmed || fallback;
}

export async function transcribeOpenAiCompatibleAudio(
  params: OpenAiCompatibleAudioParams,
): Promise<AudioTranscriptionResult> {
  const fetchFn = params.fetchFn ?? fetch;
  const baseUrl = normalizeBaseUrl(params.baseUrl, params.defaultBaseUrl);
  const allowPrivate = Boolean(params.baseUrl?.trim());
  const url = `${baseUrl}/audio/transcriptions`;

  const model = resolveModel(params.model, params.defaultModel);
  const form = new FormData();
  let fileName = params.fileName?.trim() || path.basename(params.fileName) || "audio";

  // If the filename has no extension but we know the MIME type, append the
  // correct extension so the API can identify the audio format (e.g. Signal
  // AAC voice notes arrive without an extension).
  // OpenAI only accepts: flac, mp3, mp4, mpeg, mpga, m4a, ogg, wav, webm.
  // AAC audio is the same codec wrapped in an M4A container, so remap .aac
  // to .m4a for API compatibility.
  if (!path.extname(fileName) && params.mime) {
    let ext = extensionForMime(params.mime);
    if (ext === ".aac") {
      ext = ".m4a";
    }
    if (ext) {
      fileName += ext;
    }
  }

  const bytes = new Uint8Array(params.buffer);
  const blob = new Blob([bytes], {
    type: params.mime ?? "application/octet-stream",
  });
  form.append("file", blob, fileName);
  form.append("model", model);
  if (params.language?.trim()) {
    form.append("language", params.language.trim());
  }
  if (params.prompt?.trim()) {
    form.append("prompt", params.prompt.trim());
  }

  const headers = new Headers(params.headers);
  if (!headers.has("authorization")) {
    headers.set("authorization", `Bearer ${params.apiKey}`);
  }

  const { response: res, release } = await postTranscriptionRequest({
    url,
    headers,
    body: form,
    timeoutMs: params.timeoutMs,
    fetchFn,
    allowPrivateNetwork: allowPrivate,
  });

  try {
    await assertOkOrThrowHttpError(res, "Audio transcription failed");

    const payload = (await res.json()) as { text?: string };
    const text = requireTranscriptionText(
      payload.text,
      "Audio transcription response missing text",
    );
    return { text, model };
  } finally {
    await release();
  }
}

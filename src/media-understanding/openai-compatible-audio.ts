import path from "node:path";
import {
  assertOkOrThrowHttpError,
  postTranscriptionRequest,
  resolveProviderHttpRequestConfig,
  requireTranscriptionText,
} from "./shared.js";
import type { AudioTranscriptionRequest, AudioTranscriptionResult } from "./types.js";

type OpenAiCompatibleAudioParams = AudioTranscriptionRequest & {
  defaultBaseUrl: string;
  defaultModel: string;
  provider?: string;
};

function resolveModel(model: string | undefined, fallback: string): string {
  const trimmed = model?.trim();
  return trimmed || fallback;
}

export async function transcribeOpenAiCompatibleAudio(
  params: OpenAiCompatibleAudioParams,
): Promise<AudioTranscriptionResult> {
  const fetchFn = params.fetchFn ?? fetch;
  const { baseUrl, allowPrivateNetwork, headers, dispatcherPolicy } =
    resolveProviderHttpRequestConfig({
      baseUrl: params.baseUrl,
      defaultBaseUrl: params.defaultBaseUrl,
      headers: params.headers,
      request: params.request,
      defaultHeaders: {
        authorization: `Bearer ${params.apiKey}`,
      },
      provider: params.provider,
      api: "openai-audio-transcriptions",
      capability: "audio",
      transport: "media-understanding",
    });
  const url = `${baseUrl}/audio/transcriptions`;

  const model = resolveModel(params.model, params.defaultModel);
  const fileName = params.fileName?.trim() || path.basename(params.fileName) || "audio";
  // Build the multipart body manually rather than using `new FormData()`.
  //
  // When requests go through `fetchWithRuntimeDispatcher` (undici npm package fetch
  // with a custom dispatcher), Node.js's globalThis.FormData is not recognised by
  // undici: the Content-Type multipart boundary is never set, so the server receives
  // a body it cannot parse (e.g. Flask: "No file part in the request").
  // globalThis.fetch handles globalThis.FormData correctly, but audio transcription
  // requests go through the SSRF-guarded undici path, not globalThis.fetch.
  // Constructing the body as a Buffer with an explicit Content-Type sidesteps the
  // incompatibility entirely and works with any fetch implementation.
  const mime = (params.mime ?? "application/octet-stream").replace(/[\r\n]/g, "");
  const boundary = `----FormBoundary${crypto.randomUUID().replace(/-/g, "")}`;
  const enc = new TextEncoder();
  const safeFileName = fileName.replace(/[\r\n"]/g, (c) => (c === '"' ? '\\"' : ""));
  const parts: Uint8Array[] = [
    enc.encode(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${safeFileName}"\r\nContent-Type: ${mime}\r\n\r\n`,
    ),
    new Uint8Array(params.buffer),
    enc.encode(
      `\r\n--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\n${model}\r\n`,
    ),
  ];
  if (params.language?.trim()) {
    parts.push(
      enc.encode(
        `--${boundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\n${params.language.trim()}\r\n`,
      ),
    );
  }
  if (params.prompt?.trim()) {
    parts.push(
      enc.encode(
        `--${boundary}\r\nContent-Disposition: form-data; name="prompt"\r\n\r\n${params.prompt.trim()}\r\n`,
      ),
    );
  }
  parts.push(enc.encode(`--${boundary}--\r\n`));
  const totalLen = parts.reduce((sum, p) => sum + p.length, 0);
  const body = new Uint8Array(totalLen);
  let offset = 0;
  for (const part of parts) {
    body.set(part, offset);
    offset += part.length;
  }
  const headersWithCT = new Headers(headers);
  headersWithCT.set("content-type", `multipart/form-data; boundary=${boundary}`);

  const { response: res, release } = await postTranscriptionRequest({
    url,
    headers: headersWithCT,
    body: Buffer.from(body),
    timeoutMs: params.timeoutMs,
    fetchFn,
    allowPrivateNetwork,
    dispatcherPolicy,
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

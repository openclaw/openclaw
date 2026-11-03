import type { AudioTranscriptionResult } from "../../packages/media-understanding-common/src/types.js";
import { asOptionalRecord } from "../../packages/normalization-core/src/record-coerce.js";
import {
  assertOkOrThrowHttpError,
  postTranscriptionRequest,
  readProviderJsonObjectResponse,
  requireTranscriptionText,
  type resolveProviderHttpRequestConfigWithOriginTrust,
} from "./shared.js";
import type { AudioTranscriptionRequest } from "./types.js";

function readDeepgramTranscript(payload: Record<string, unknown>): string | undefined {
  const results = asOptionalRecord(payload.results);
  if (!results) {
    return undefined;
  }
  if (!Array.isArray(results.channels)) {
    throw new Error("Audio transcription failed: malformed JSON response");
  }
  const transcripts: string[] = [];
  for (const rawChannel of results.channels) {
    const channel = asOptionalRecord(rawChannel);
    if (!channel) {
      return undefined;
    }
    if (!Array.isArray(channel.alternatives)) {
      throw new Error("Audio transcription failed: malformed JSON response");
    }
    const alternative = asOptionalRecord(channel.alternatives[0]);
    if (!alternative || alternative.transcript === undefined) {
      return undefined;
    }
    if (typeof alternative.transcript !== "string") {
      throw new Error("Audio transcription failed: malformed JSON response");
    }
    transcripts.push(alternative.transcript.trim());
  }
  // Multichannel results contain independent tracks, not alternative hypotheses.
  // Retain the best transcript per track in provider order, including repeats.
  return transcripts.length ? transcripts.filter(Boolean).join("\n\n") : undefined;
}

/** Native prerecorded channel transcription; callers own model, auth and destination selection. */
export async function transcribeDeepgramPrerecordedAudio({
  request: params,
  requestConfig,
  model,
}: {
  request: AudioTranscriptionRequest;
  requestConfig: ReturnType<typeof resolveProviderHttpRequestConfigWithOriginTrust>;
  model: string;
}): Promise<AudioTranscriptionResult> {
  const fetchFn = params.fetchFn ?? fetch;
  const { baseUrl, allowPrivateNetwork, headers, dispatcherPolicy } = requestConfig;

  const url = new URL(`${baseUrl}/listen`);
  url.searchParams.set("model", model);
  if (params.language?.trim()) {
    url.searchParams.set("language", params.language.trim());
  }
  if (params.query) {
    for (const [key, value] of Object.entries(params.query)) {
      if (value === undefined) {
        continue;
      }
      if (Array.isArray(value)) {
        url.searchParams.delete(key);
        for (const item of value) url.searchParams.append(key, item);
      } else {
        url.searchParams.set(key, String(value));
      }
    }
  }

  const body = new Uint8Array(params.buffer);
  const { response: res, release } = await postTranscriptionRequest({
    url: url.toString(),
    headers,
    body,
    timeoutMs: params.timeoutMs,
    ...(params.signal ? { signal: params.signal } : {}),
    fetchFn,
    allowPrivateNetwork,
    dispatcherPolicy,
  });

  try {
    await assertOkOrThrowHttpError(res, "Audio transcription failed", { requestHeaders: headers });

    const payload = await readProviderJsonObjectResponse(res, "Audio transcription failed", {
      requestHeaders: headers,
    });
    const transcript = requireTranscriptionText(
      readDeepgramTranscript(payload),
      "Audio transcription response missing transcript",
    );
    return { text: transcript, model };
  } finally {
    await release();
  }
}

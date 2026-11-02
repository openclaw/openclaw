// Core facade for shared OpenAI-compatible video request helpers.
import {
  buildOpenAiCompatibleVideoRequestBody,
  coerceOpenAiCompatibleVideoText,
  resolveMediaUnderstandingString,
  type OpenAiCompatibleVideoPayload,
} from "../../packages/media-understanding-common/src/openai-compatible-video.js";
import { postJsonResponse } from "./provider-json-post.js";
import { buildOpenAiCompatibleAuthHeaders, resolveProviderHttpRequestConfig } from "./shared.js";
import type { VideoDescriptionRequest, VideoDescriptionResult } from "./types.js";

export * from "../../packages/media-understanding-common/src/openai-compatible-video.js";

/** Describe a video through an OpenAI-compatible chat-completions endpoint. */
export async function describeOpenAiCompatibleVideo(
  params: VideoDescriptionRequest & {
    defaultBaseUrl: string;
    defaultModel: string;
    defaultPrompt: string;
    provider: string;
    providerLabel: string;
  },
): Promise<VideoDescriptionResult> {
  const fetchFn = params.fetchFn ?? fetch;
  const model = resolveMediaUnderstandingString(params.model, params.defaultModel);
  const mime = resolveMediaUnderstandingString(params.mime, "video/mp4");
  const prompt = resolveMediaUnderstandingString(params.prompt, params.defaultPrompt);
  const errorPrefix = `${params.providerLabel} video description`;
  const { baseUrl, allowPrivateNetwork, headers, dispatcherPolicy } =
    resolveProviderHttpRequestConfig({
      baseUrl: params.baseUrl,
      defaultBaseUrl: params.defaultBaseUrl,
      headers: params.headers,
      request: params.request,
      defaultHeaders: {
        "content-type": "application/json",
        ...buildOpenAiCompatibleAuthHeaders(params),
      },
      provider: params.provider,
      api: "openai-completions",
      capability: "video",
      transport: "media-understanding",
    });

  const payload = await postJsonResponse<OpenAiCompatibleVideoPayload>({
    url: `${baseUrl}/chat/completions`,
    headers,
    body: buildOpenAiCompatibleVideoRequestBody({
      model,
      prompt,
      mime,
      buffer: params.buffer,
    }),
    timeoutMs: params.timeoutMs,
    ...(params.signal ? { signal: params.signal } : {}),
    fetchFn,
    allowPrivateNetwork,
    dispatcherPolicy,
    errorLabel: `${errorPrefix} failed`,
    errorOptions: { requestHeaders: headers },
    readOptions: { requestHeaders: headers },
  });

  const text = coerceOpenAiCompatibleVideoText(payload);
  if (!text) {
    throw new Error(`${errorPrefix} response missing content`);
  }
  return { text, model };
}

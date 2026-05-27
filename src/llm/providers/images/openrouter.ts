import OpenAI from "openai";
import type {
  ChatCompletion,
  ChatCompletionContentPart,
  ChatCompletionContentPartImage,
  ChatCompletionContentPartText,
  ChatCompletionCreateParamsNonStreaming,
} from "openai/resources/chat/completions.js";
import { getEnvApiKey } from "../../env-api-keys.js";
import type {
  AssistantImages,
  ImageContent,
  ImagesContext,
  ImagesFunction,
  ImagesModel,
  ImagesOptions,
  TextContent,
} from "../../types.js";
import { headersToRecord } from "../../utils/headers.js";
import { sanitizeSurrogates } from "../../utils/sanitize-unicode.js";

interface OpenRouterGeneratedImage {
  image_url?: string | { url?: string };
}

type OpenRouterImageGenerationMessage = ChatCompletion["choices"][number]["message"] & {
  images?: OpenRouterGeneratedImage[];
};

type OpenRouterImageGenerationChoice = ChatCompletion["choices"][number] & {
  message: OpenRouterImageGenerationMessage;
};

type OpenRouterImageGenerationResponse = ChatCompletion & {
  choices: OpenRouterImageGenerationChoice[];
};

export const generateImagesOpenRouter: ImagesFunction<"openrouter-images"> = async (
  model: ImagesModel<"openrouter-images">,
  context: ImagesContext,
  options?: ImagesOptions,
) => {
  const output: AssistantImages = {
    api: model.api,
    provider: model.provider,
    model: model.id,
    output: [],
    stopReason: "stop",
    timestamp: Date.now(),
  };

  try {
    const apiKey = options?.apiKey || getEnvApiKey(model.provider);
    if (!apiKey) {
      throw new Error(`No API key available for provider: ${model.provider}`);
    }
    const client = createClient(model, apiKey, options?.headers);
    let params = buildParams(model, context);
    const nextParams = await options?.onPayload?.(params, model);
    if (nextParams !== undefined) {
      params = nextParams as typeof params;
    }
    const requestOptions = {
      ...(options?.signal ? { signal: options.signal } : {}),
      ...(options?.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
      ...(options?.maxRetries !== undefined ? { maxRetries: options.maxRetries } : {}),
    };
    const { data: response, response: rawResponse } = await client.chat.completions
      .create(params as unknown as ChatCompletionCreateParamsNonStreaming, requestOptions)
      .withResponse();
    await options?.onResponse?.(
      { status: rawResponse.status, headers: headersToRecord(rawResponse.headers) },
      model,
    );

    const imageResponse = response as OpenRouterImageGenerationResponse;
    output.responseId = imageResponse.id;
    if (imageResponse.usage) {
      output.usage = parseUsage(imageResponse.usage, model);
    }

    const choice = imageResponse.choices[0];
    if (choice) {
      const content = choice.message.content;
      if (typeof content === "string" && content.length > 0) {
        output.output.push({ type: "text", text: content } satisfies TextContent);
      }

      for (const image of choice.message.images ?? []) {
        const imageUrl =
          typeof image.image_url === "string" ? image.image_url : image.image_url?.url;
        if (!imageUrl?.startsWith("data:")) {
          continue;
        }
        const matches = imageUrl.match(/^data:([^;]+);base64,(.+)$/);
        if (!matches) {
          continue;
        }
        output.output.push({
          type: "image",
          mimeType: matches[1],
          data: matches[2],
        } satisfies ImageContent);
      }
    }

    return output;
  } catch (error) {
    output.stopReason = options?.signal?.aborted ? "aborted" : "error";
    output.errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
    return output;
  }
};

function createClient(
  model: ImagesModel<"openrouter-images">,
  apiKey: string,
  optionsHeaders?: Record<string, string>,
): OpenAI {
  return new OpenAI({
    apiKey,
    baseURL: model.baseUrl,
    dangerouslyAllowBrowser: true,
    defaultHeaders: {
      ...model.headers,
      ...optionsHeaders,
    },
  });
}

type OpenRouterImagesCreateParams = Omit<ChatCompletionCreateParamsNonStreaming, "modalities"> & {
  modalities: Array<"image" | "text">;
};

function buildParams(
  model: ImagesModel<"openrouter-images">,
  context: ImagesContext,
): OpenRouterImagesCreateParams {
  const content: ChatCompletionContentPart[] = context.input.map(
    (item): ChatCompletionContentPart => {
      if (item.type === "text") {
        return {
          type: "text",
          text: sanitizeSurrogates(item.text),
        } satisfies ChatCompletionContentPartText;
      }
      return {
        type: "image_url",
        image_url: {
          url: `data:${item.mimeType};base64,${item.data}`,
        },
      } satisfies ChatCompletionContentPartImage;
    },
  );

  return {
    model: model.id,
    messages: [
      {
        role: "user" as const,
        content,
      },
    ],
    stream: false,
    modalities: model.output.includes("text") ? ["image", "text"] : ["image"],
  };
}

function parseUsage(
  rawUsage: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
  },
  model: ImagesModel<"openrouter-images">,
) {
  const promptTokens = rawUsage.prompt_tokens || 0;
  const reportedCachedTokens = rawUsage.prompt_tokens_details?.cached_tokens || 0;
  const cacheWriteTokens = rawUsage.prompt_tokens_details?.cache_write_tokens || 0;
  const cacheReadTokens =
    cacheWriteTokens > 0
      ? Math.max(0, reportedCachedTokens - cacheWriteTokens)
      : reportedCachedTokens;
  const input = Math.max(0, promptTokens - cacheReadTokens - cacheWriteTokens);
  const output = rawUsage.completion_tokens || 0;
  const usage = {
    input,
    output,
    cacheRead: cacheReadTokens,
    cacheWrite: cacheWriteTokens,
    totalTokens: input + output + cacheReadTokens + cacheWriteTokens,
    cost: {
      input: (model.cost.input / 1000000) * input,
      output: (model.cost.output / 1000000) * output,
      cacheRead: (model.cost.cacheRead / 1000000) * cacheReadTokens,
      cacheWrite: (model.cost.cacheWrite / 1000000) * cacheWriteTokens,
      total: 0,
    },
  };
  usage.cost.total =
    usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
  return usage;
}

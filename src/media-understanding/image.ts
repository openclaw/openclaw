import type { Api, Context, Model, ProviderStreamOptions } from "@mariozechner/pi-ai";
import { complete } from "@mariozechner/pi-ai";
import { isMinimaxVlmModel, minimaxUnderstandImage } from "../agents/minimax-vlm.js";
import {
  getApiKeyForModel,
  requireApiKey,
  resolveApiKeyForProvider,
} from "../agents/model-auth.js";
import { findNormalizedProviderValue, normalizeModelRef } from "../agents/model-selection.js";
import { ensureOpenClawModelsJson } from "../agents/models-config.js";
import { sanitizeModelHeaders } from "../agents/pi-embedded-runner/model.inline-provider.js";
import { resolveModelWithRegistry } from "../agents/pi-embedded-runner/model.js";
import { resolveProviderRequestCapabilities } from "../agents/provider-attribution.js";
import {
  coerceImageAssistantText,
  hasImageReasoningOnlyResponse,
} from "../agents/tools/image-tool.helpers.js";
import type {
  ImageDescriptionRequest,
  ImageDescriptionResult,
  ImagesDescriptionRequest,
  ImagesDescriptionResult,
} from "./types.js";

let piModelDiscoveryRuntimePromise: Promise<
  typeof import("../agents/pi-model-discovery-runtime.js")
> | null = null;

function loadPiModelDiscoveryRuntime() {
  piModelDiscoveryRuntimePromise ??= import("../agents/pi-model-discovery-runtime.js");
  return piModelDiscoveryRuntimePromise;
}

function resolveImageToolMaxTokens(modelMaxTokens: number | undefined, requestedMaxTokens = 4096) {
  if (
    typeof modelMaxTokens !== "number" ||
    !Number.isFinite(modelMaxTokens) ||
    modelMaxTokens <= 0
  ) {
    return requestedMaxTokens;
  }
  return Math.min(requestedMaxTokens, modelMaxTokens);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNativeResponsesReasoningPayload(model: Model<Api>): boolean {
  if (
    model.api !== "openai-responses" &&
    model.api !== "azure-openai-responses" &&
    model.api !== "openai-codex-responses"
  ) {
    return false;
  }
  return resolveProviderRequestCapabilities({
    provider: model.provider,
    api: model.api,
    baseUrl: model.baseUrl,
    capability: "image",
    transport: "media-understanding",
  }).usesKnownNativeOpenAIRoute;
}

function removeReasoningInclude(value: unknown): unknown {
  if (!Array.isArray(value)) {
    return value;
  }
  const next = value.filter((entry) => entry !== "reasoning.encrypted_content");
  return next.length > 0 ? next : undefined;
}

function disableReasoningForImageRetryPayload(payload: unknown, model: Model<Api>): unknown {
  if (!isRecord(payload)) {
    return undefined;
  }
  const next = { ...payload };
  delete next.reasoning;
  delete next.reasoning_effort;

  const include = removeReasoningInclude(next.include);
  if (include === undefined) {
    delete next.include;
  } else {
    next.include = include;
  }

  if (isNativeResponsesReasoningPayload(model)) {
    next.reasoning = { effort: "none" };
  }
  return next;
}

function isImageModelNoTextError(err: unknown): boolean {
  return err instanceof Error && /^Image model returned no text\b/.test(err.message);
}

async function resolveImageRuntime(params: {
  cfg: ImageDescriptionRequest["cfg"];
  agentDir: string;
  provider: string;
  model: string;
  profile?: string;
  preferredProfile?: string;
  authStore?: ImageDescriptionRequest["authStore"];
}): Promise<{ apiKey: string; model: Model<Api> }> {
  await ensureOpenClawModelsJson(params.cfg, params.agentDir);
  const { discoverAuthStorage, discoverModels } = await loadPiModelDiscoveryRuntime();
  const authStorage = discoverAuthStorage(params.agentDir);
  const modelRegistry = discoverModels(authStorage, params.agentDir);
  const resolvedRef = normalizeModelRef(params.provider, params.model);

  // Use the full model resolution stack (registry → inline config → plugin →
  // ad-hoc provider config) instead of bare modelRegistry.find(), which misses
  // user-configured custom provider models (e.g. vllm, nvidia-api, iflow).
  let model: Model<Api> | null =
    resolveModelWithRegistry({
      provider: resolvedRef.provider,
      modelId: resolvedRef.model,
      modelRegistry,
      cfg: params.cfg,
      agentDir: params.agentDir,
    }) ?? null;

  if (!model) {
    throw new Error(`Unknown model: ${resolvedRef.provider}/${resolvedRef.model}`);
  }

  // When the model was resolved via the ad-hoc provider config fallback, the
  // input field defaults to ["text"] because the config model lookup uses exact
  // ID matching which can miss provider-prefixed IDs (e.g. "vllm/Qwen3.5" in
  // config vs "Qwen3.5" after model ref parsing).  Check the user's configured
  // model definition for explicit image support so the tool works correctly.
  // We prefer the exact params.provider key first so that configs containing
  // both an alias (e.g. "nvidia-api") and the canonical name ("nvidia") resolve
  // to the correct block — findNormalizedProviderValue would pick whichever
  // entry normalizes first, which may be the wrong one.
  if (!model.input?.includes("image")) {
    const providers = params.cfg?.models?.providers;
    const providerConfig =
      providers?.[params.provider] ?? findNormalizedProviderValue(providers, resolvedRef.provider);
    const configuredModel = providerConfig?.models?.find(
      (m) =>
        m.id === resolvedRef.model ||
        m.id === `${params.provider}/${resolvedRef.model}` ||
        m.id === `${resolvedRef.provider}/${resolvedRef.model}`,
    );
    if (configuredModel?.input?.includes("image")) {
      // Preserve per-model headers (e.g. routing/version headers for vllm)
      // since resolveConfiguredFallbackModel missed this config entry due to
      // exact-id matching on the unprefixed modelId. Model-level headers
      // override provider-level headers already on the resolved model.
      const configuredModelHeaders = sanitizeModelHeaders(configuredModel.headers, {
        stripSecretRefMarkers: true,
      });
      const mergedHeaders = configuredModelHeaders
        ? { ...(model.headers ?? {}), ...configuredModelHeaders }
        : model.headers;
      model = {
        ...model,
        input: configuredModel.input,
        ...(configuredModel.api ? { api: configuredModel.api } : {}),
        ...(mergedHeaders ? { headers: mergedHeaders } : {}),
      } as Model<Api>;
    }
  }

  if (!model.input?.includes("image")) {
    throw new Error(`Model does not support images: ${params.provider}/${params.model}`);
  }
  const apiKeyInfo = await getApiKeyForModel({
    model,
    cfg: params.cfg,
    agentDir: params.agentDir,
    profileId: params.profile,
    preferredProfile: params.preferredProfile,
    store: params.authStore,
  });
  const apiKey = requireApiKey(apiKeyInfo, model.provider);
  authStorage.setRuntimeApiKey(model.provider, apiKey);
  return { apiKey, model };
}

function buildImageContext(
  prompt: string,
  images: Array<{ buffer: Buffer; mime?: string }>,
): Context {
  return {
    systemPrompt: prompt,
    messages: [
      {
        role: "user",
        content: images.map((image) => ({
          type: "image" as const,
          data: image.buffer.toString("base64"),
          mimeType: image.mime ?? "image/jpeg",
        })),
        timestamp: Date.now(),
      },
    ],
  };
}

async function describeImagesWithMinimax(params: {
  apiKey: string;
  modelId: string;
  modelBaseUrl?: string;
  prompt: string;
  images: Array<{ buffer: Buffer; mime?: string }>;
}): Promise<ImagesDescriptionResult> {
  const responses: string[] = [];
  for (const [index, image] of params.images.entries()) {
    const prompt =
      params.images.length > 1
        ? `${params.prompt}\n\nDescribe image ${index + 1} of ${params.images.length} independently.`
        : params.prompt;
    const text = await minimaxUnderstandImage({
      apiKey: params.apiKey,
      prompt,
      imageDataUrl: `data:${image.mime ?? "image/jpeg"};base64,${image.buffer.toString("base64")}`,
      modelBaseUrl: params.modelBaseUrl,
    });
    responses.push(params.images.length > 1 ? `Image ${index + 1}:\n${text.trim()}` : text.trim());
  }
  return {
    text: responses.join("\n\n").trim(),
    model: params.modelId,
  };
}

function isUnknownModelError(err: unknown): boolean {
  return err instanceof Error && /^Unknown model:/i.test(err.message);
}

function resolveConfiguredProviderBaseUrl(
  cfg: ImageDescriptionRequest["cfg"],
  provider: string,
): string | undefined {
  const direct = cfg.models?.providers?.[provider];
  if (typeof direct?.baseUrl === "string" && direct.baseUrl.trim()) {
    return direct.baseUrl.trim();
  }
  return undefined;
}

async function resolveMinimaxVlmFallbackRuntime(params: {
  cfg: ImageDescriptionRequest["cfg"];
  agentDir: string;
  provider: string;
  profile?: string;
  preferredProfile?: string;
}): Promise<{ apiKey: string; modelBaseUrl?: string }> {
  const auth = await resolveApiKeyForProvider({
    provider: params.provider,
    cfg: params.cfg,
    profileId: params.profile,
    preferredProfile: params.preferredProfile,
    agentDir: params.agentDir,
  });
  return {
    apiKey: requireApiKey(auth, params.provider),
    modelBaseUrl: resolveConfiguredProviderBaseUrl(params.cfg, params.provider),
  };
}

export async function describeImagesWithModel(
  params: ImagesDescriptionRequest,
): Promise<ImagesDescriptionResult> {
  const prompt = params.prompt ?? "Describe the image.";
  let apiKey: string;
  let model: Model<Api> | undefined;

  try {
    const resolved = await resolveImageRuntime(params);
    apiKey = resolved.apiKey;
    model = resolved.model;
  } catch (err) {
    if (!isMinimaxVlmModel(params.provider, params.model) || !isUnknownModelError(err)) {
      throw err;
    }
    const fallback = await resolveMinimaxVlmFallbackRuntime(params);
    return await describeImagesWithMinimax({
      apiKey: fallback.apiKey,
      modelId: params.model,
      modelBaseUrl: fallback.modelBaseUrl,
      prompt,
      images: params.images,
    });
  }

  if (isMinimaxVlmModel(model.provider, model.id)) {
    return await describeImagesWithMinimax({
      apiKey,
      modelId: model.id,
      modelBaseUrl: model.baseUrl,
      prompt,
      images: params.images,
    });
  }

  const context = buildImageContext(prompt, params.images);
  const controller = new AbortController();
  const timeout =
    typeof params.timeoutMs === "number" &&
    Number.isFinite(params.timeoutMs) &&
    params.timeoutMs > 0
      ? setTimeout(() => controller.abort(), params.timeoutMs)
      : undefined;

  const maxTokens = resolveImageToolMaxTokens(model.maxTokens, params.maxTokens ?? 512);
  const completeImage = async (onPayload?: ProviderStreamOptions["onPayload"]) =>
    await complete(model, context, {
      apiKey,
      maxTokens,
      signal: controller.signal,
      ...(onPayload ? { onPayload } : {}),
    });

  try {
    const message = await completeImage();
    try {
      const text = coerceImageAssistantText({
        message,
        provider: model.provider,
        model: model.id,
      });
      return { text, model: model.id };
    } catch (err) {
      if (!isImageModelNoTextError(err) || !hasImageReasoningOnlyResponse(message)) {
        throw err;
      }
    }

    const retryMessage = await completeImage(disableReasoningForImageRetryPayload);
    const text = coerceImageAssistantText({
      message: retryMessage,
      provider: model.provider,
      model: model.id,
    });
    return { text, model: model.id };
  } finally {
    clearTimeout(timeout);
  }
}

export async function describeImageWithModel(
  params: ImageDescriptionRequest,
): Promise<ImageDescriptionResult> {
  return await describeImagesWithModel({
    images: [
      {
        buffer: params.buffer,
        fileName: params.fileName,
        mime: params.mime,
      },
    ],
    model: params.model,
    provider: params.provider,
    prompt: params.prompt,
    maxTokens: params.maxTokens,
    timeoutMs: params.timeoutMs,
    profile: params.profile,
    preferredProfile: params.preferredProfile,
    authStore: params.authStore,
    agentDir: params.agentDir,
    cfg: params.cfg,
  });
}

import { clampPositiveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeMediaProviderId } from "../../packages/media-understanding-common/src/provider-id.js";
import { raceWithTimeout } from "../../packages/retry/src/index.js";
import { isMinimaxVlmModel, minimaxUnderstandImage } from "../agents/minimax-vlm.js";
import { requireApiKey, resolveApiKeyForProviderCore } from "../agents/model-auth.js";
import { resolveProviderRequestCapabilities } from "../agents/provider-attribution.js";
import {
  getModelProviderRequestRouteFacts,
  getModelProviderRequestTransport,
} from "../agents/provider-request-config.js";
import type { ModelProviderRequestTransportOverrides } from "../agents/provider-request-config.types.js";
import {
  unwrapModelHeaderSentinelsForProviderEgress,
  unwrapSecretSentinelsForProviderEgress,
} from "../agents/provider-secret-egress.js";
import { registerProviderStreamForModel } from "../agents/provider-stream.js";
import {
  coerceImageAssistantText,
  hasImageReasoningOnlyResponse,
} from "../agents/tools/image-tool.helpers.js";
import { isSecretRef } from "../config/types.secrets.js";
import { racePromiseWithAbortSignal } from "../infra/abort-signal.js";
import { complete } from "../llm/stream.js";
import type { AssistantMessage, Context, Model, ProviderStreamOptions } from "../llm/types.js";
import { runPluginStreamConsumer } from "../plugins/plugin-instance-scope.js";
import { runWithAsyncWorkResources } from "../shared/async-work-resources.js";
import { trackAsyncWork } from "../shared/async-work-scope.js";
import { getResolvedImageRuntimeContext, resolveImageRuntime } from "./image-model-runtime.js";
import type {
  ImageDescriptionRequest,
  ImageDescriptionResult,
  ImagesDescriptionRequest,
  ImagesDescriptionResult,
} from "./types.js";

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

function isNativeResponsesReasoningPayload(model: Model): boolean {
  if (
    model.api !== "openai-responses" &&
    model.api !== "azure-openai-responses" &&
    model.api !== "openai-chatgpt-responses"
  ) {
    return false;
  }
  return resolveProviderRequestCapabilities({
    provider: model.provider,
    api: model.api,
    baseUrl: model.baseUrl,
    capability: "image",
    transport: "media-understanding",
    providerMetadataOwners: getModelProviderRequestRouteFacts(model)?.providerMetadataOwners,
  }).usesKnownNativeOpenAIRoute;
}

function disableReasoningForImageRetryPayload(payload: unknown, model: Model): unknown {
  // Empty-text image responses can be caused by reasoning-only payloads; retry
  // with reasoning stripped while preserving provider-specific Responses shape.
  if (!isRecord(payload)) {
    return undefined;
  }
  const next = { ...payload };
  delete next.reasoning;
  delete next.reasoning_effort;

  const include = Array.isArray(next.include)
    ? next.include.filter((entry) => entry !== "reasoning.encrypted_content")
    : next.include;
  if (include === undefined || (Array.isArray(include) && include.length === 0)) {
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

function imageRetryPayloadHandler(
  onPayload: ProviderStreamOptions["onPayload"],
): NonNullable<ProviderStreamOptions["onPayload"]> {
  return (payload, payloadModel) => {
    const stripped = disableReasoningForImageRetryPayload(payload, payloadModel);
    const result = onPayload?.(stripped === undefined ? payload : stripped, payloadModel);
    const fallback = (value: unknown) => (value === undefined ? stripped : value);
    return isPromiseLike(result) ? Promise.resolve(result).then(fallback) : fallback(result);
  };
}

function shouldPlaceImagePromptInUserContent(model: Model): boolean {
  // GitHub Copilot models (including Gemini 3.1 Pro Preview) require the
  // prompt text to be in the user message alongside the image. Placing it
  // in a separate system message produces "Request must contain at least
  // one non-empty message" (400).
  if (model.provider === "github-copilot") {
    return true;
  }
  const capabilities = resolveProviderRequestCapabilities({
    provider: model.provider,
    api: model.api,
    baseUrl: model.baseUrl,
    capability: "image",
    transport: "media-understanding",
    providerMetadataOwners: getModelProviderRequestRouteFacts(model)?.providerMetadataOwners,
  });
  return (
    capabilities.endpointClass === "openrouter" ||
    capabilities.endpointClass === "modelstudio-native" ||
    (model.provider.toLowerCase() === "openrouter" && capabilities.endpointClass === "default")
  );
}

async function describeImagesWithMinimax(params: {
  runtimeValue: string;
  provider: string;
  modelId: string;
  modelBaseUrl?: string;
  prompt: string;
  timeoutMs?: number;
  images: Array<{ buffer: Buffer; mime?: string }>;
  allowPrivateNetwork?: boolean;
  request?: ModelProviderRequestTransportOverrides;
  signal?: AbortSignal;
  assertResourcesOpen?: () => void;
}): Promise<ImagesDescriptionResult> {
  const responses: string[] = [];
  // MiniMax VLM handles its own outbound fetch, so unwrap only at this final handoff.
  const apiKey = unwrapSecretSentinelsForProviderEgress(params.runtimeValue, "MiniMax VLM request");
  for (const [index, image] of params.images.entries()) {
    // One MiniMax request is issued per image, so cancellation must gate every
    // iteration or a dead run can continue buying calls after the first image.
    params.signal?.throwIfAborted();
    params.assertResourcesOpen?.();
    const prompt =
      params.images.length > 1
        ? `${params.prompt}\n\nDescribe image ${index + 1} of ${params.images.length} independently.`
        : params.prompt;
    const text = await minimaxUnderstandImage({
      apiKey,
      provider: params.provider,
      prompt,
      imageDataUrl: `data:${image.mime ?? "image/jpeg"};base64,${image.buffer.toString("base64")}`,
      modelBaseUrl: params.modelBaseUrl,
      timeoutMs: params.timeoutMs,
      allowPrivateNetwork: params.allowPrivateNetwork,
      request: params.request,
      signal: params.signal,
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
  const normalizedProvider = normalizeMediaProviderId(provider);
  const normalized = cfg.models?.providers?.[normalizedProvider];
  if (typeof normalized?.baseUrl === "string" && normalized.baseUrl.trim()) {
    if (isMinimaxCnAlias(provider) && !isMinimaxCnBaseUrl(normalized.baseUrl)) {
      return undefined;
    }
    return normalized.baseUrl.trim();
  }
  return undefined;
}

function resolveConfiguredProviderAllowPrivateNetwork(
  cfg: ImageDescriptionRequest["cfg"],
  provider: string,
): boolean | undefined {
  const direct = cfg.models?.providers?.[provider]?.request?.allowPrivateNetwork;
  if (typeof direct === "boolean") {
    return direct;
  }
  const normalizedProvider = normalizeMediaProviderId(provider);
  const normalized = cfg.models?.providers?.[normalizedProvider]?.request?.allowPrivateNetwork;
  if (typeof normalized === "boolean") {
    return normalized;
  }
  return undefined;
}

function isMinimaxCnAlias(provider: string): boolean {
  const normalized = provider.trim().toLowerCase();
  return normalized === "minimax-cn" || normalized === "minimax-portal-cn";
}

function isMinimaxCnBaseUrl(baseUrl: string): boolean {
  const trimmed = baseUrl.trim();
  if (!trimmed) {
    return false;
  }
  try {
    const parsed = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
    return parsed.hostname.toLowerCase() === "api.minimaxi.com";
  } catch {
    return false;
  }
}

function hasConfiguredProviderApiKey(
  cfg: ImageDescriptionRequest["cfg"],
  provider: string,
): boolean {
  const apiKey = cfg.models?.providers?.[provider]?.apiKey;
  return (typeof apiKey === "string" && apiKey.trim().length > 0) || isSecretRef(apiKey);
}

function resolveMinimaxVlmAuthProvider(
  cfg: ImageDescriptionRequest["cfg"],
  provider: string,
): string {
  if (!isMinimaxCnAlias(provider) || hasConfiguredProviderApiKey(cfg, provider)) {
    return provider;
  }
  return normalizeMediaProviderId(provider);
}

async function resolveMinimaxVlmFallbackRuntime(params: {
  cfg: ImageDescriptionRequest["cfg"];
  agentDir: string;
  workspaceDir?: string;
  provider: string;
  profile?: string;
  preferredProfile?: string;
}): Promise<{ runtimeValue: string; modelBaseUrl?: string }> {
  const authProvider = resolveMinimaxVlmAuthProvider(params.cfg, params.provider);
  const auth = await resolveApiKeyForProviderCore({
    provider: authProvider,
    cfg: params.cfg,
    secretSentinels: true,
    profileId: params.profile,
    preferredProfile: params.preferredProfile,
    agentDir: params.agentDir,
    ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
  });
  return {
    runtimeValue: requireApiKey(auth, authProvider),
    modelBaseUrl: resolveConfiguredProviderBaseUrl(params.cfg, params.provider),
  };
}

function buildImageDescriptionTimeoutError(params: {
  phase: "setup" | "request";
  timeoutMs: number;
  setupDurationMs?: number;
}): Error {
  if (params.phase === "setup") {
    return new Error(
      `image description setup timed out after ${params.timeoutMs}ms before provider request started`,
    );
  }
  const setupDurationMs =
    typeof params.setupDurationMs === "number" && Number.isFinite(params.setupDurationMs)
      ? Math.max(0, Math.floor(params.setupDurationMs))
      : 0;
  return new Error(
    setupDurationMs > 0
      ? `image description request timed out after ${params.timeoutMs}ms (setup took ${setupDurationMs}ms before provider request started)`
      : `image description request timed out after ${params.timeoutMs}ms`,
  );
}

async function withImageDescriptionTimeout<T>(params: {
  task: Promise<T>;
  timeoutMs: number | undefined;
  controller: AbortController;
  signal?: AbortSignal;
  createTimeoutError: (timeoutMs: number) => Error;
}): Promise<T> {
  params.signal?.throwIfAborted();
  const abortError = (signal: AbortSignal) =>
    signal.reason instanceof Error
      ? signal.reason
      : new Error("image description aborted", { cause: signal.reason });
  if (params.timeoutMs === undefined) {
    return await racePromiseWithAbortSignal(params.task, params.signal, abortError);
  }
  const timeoutMs = params.timeoutMs;
  return await raceWithTimeout(
    params.task,
    timeoutMs,
    () => {
      params.controller.abort();
      throw params.createTimeoutError(timeoutMs);
    },
    {
      signal: params.signal,
      onAbort: (signal) => {
        throw abortError(signal);
      },
    },
  );
}

export async function describeImagesWithModelPayloadTransformCore(
  params: ImagesDescriptionRequest,
  onPayload: ProviderStreamOptions["onPayload"],
): Promise<ImagesDescriptionResult> {
  return await runWithAsyncWorkResources(async (onAcquired) => {
    let assertResourcesOpen: (() => void) | undefined;
    const prompt = params.prompt ?? "Describe the image.";
    params.signal?.throwIfAborted();
    const startedAtMs = Date.now();
    const controller = new AbortController();
    const requestSignal = params.signal
      ? AbortSignal.any([params.signal, controller.signal])
      : controller.signal;
    const configuredTimeoutMs = clampPositiveTimerTimeoutMs(params.timeoutMs);
    const allowPrivateNetwork = resolveConfiguredProviderAllowPrivateNetwork(
      params.cfg,
      params.provider,
    );
    let runtimeValue: string;
    let model: Model | undefined;
    const resolutionTask = trackAsyncWork(() =>
      resolveImageRuntime({ ...params, signal: requestSignal }, (resources) => {
        onAcquired({ release: async () => await resources[Symbol.asyncDispose]() });
        assertResourcesOpen = resources.assertResourcesOpen;
      }),
    );

    try {
      const resolved = await withImageDescriptionTimeout({
        controller,
        signal: params.signal,
        timeoutMs: configuredTimeoutMs,
        createTimeoutError: (timeoutMs) =>
          buildImageDescriptionTimeoutError({ phase: "setup", timeoutMs }),
        task: resolutionTask,
      });
      runtimeValue = resolved.runtimeValue;
      model = resolved.model;
    } catch (err) {
      params.signal?.throwIfAborted();
      if (!isMinimaxVlmModel(params.provider, params.model) || !isUnknownModelError(err)) {
        throw err;
      }
      const fallback = await withImageDescriptionTimeout({
        controller,
        signal: params.signal,
        timeoutMs: configuredTimeoutMs,
        createTimeoutError: (timeoutMs) =>
          buildImageDescriptionTimeoutError({ phase: "setup", timeoutMs }),
        task: trackAsyncWork(() => resolveMinimaxVlmFallbackRuntime(params)),
      });
      return await describeImagesWithMinimax({
        assertResourcesOpen,
        runtimeValue: fallback.runtimeValue,
        provider: params.provider,
        modelId: params.model,
        modelBaseUrl: fallback.modelBaseUrl,
        prompt,
        timeoutMs: params.timeoutMs,
        images: params.images,
        allowPrivateNetwork,
        signal: params.signal,
      });
    }

    const apiKey = runtimeValue;
    params.signal?.throwIfAborted();
    assertResourcesOpen?.();
    const setupDurationMs = Date.now() - startedAtMs;

    if (isMinimaxVlmModel(model.provider, model.id)) {
      return await describeImagesWithMinimax({
        assertResourcesOpen,
        runtimeValue,
        provider: model.provider,
        modelId: model.id,
        modelBaseUrl: model.baseUrl,
        prompt,
        timeoutMs: params.timeoutMs,
        images: params.images,
        request: getModelProviderRequestTransport(model),
        signal: params.signal,
      });
    }

    const resolvedRuntimeContext = getResolvedImageRuntimeContext(model);
    // Prepared auth may carry sentinel-protected request headers. Resolve them only at this
    // final direct-completion boundary so provider SDKs never receive sentinel placeholders.
    const requestModel = unwrapModelHeaderSentinelsForProviderEgress(
      model,
      "image description provider request",
    );
    const providerStreamFn = registerProviderStreamForModel({
      model: requestModel,
      cfg: resolvedRuntimeContext?.cfg ?? params.cfg,
      agentDir: resolvedRuntimeContext?.agentDir ?? params.agentDir,
      wrapProviderStream: true,
      ...(resolvedRuntimeContext?.workspaceDir
        ? { workspaceDir: resolvedRuntimeContext.workspaceDir }
        : params.workspaceDir
          ? { workspaceDir: params.workspaceDir }
          : {}),
    });

    const promptInUserContent = shouldPlaceImagePromptInUserContent(model);
    const context: Context = {
      ...(promptInUserContent ? {} : { systemPrompt: prompt }),
      messages: [
        {
          role: "user",
          content: [
            ...(promptInUserContent ? [{ type: "text" as const, text: prompt }] : []),
            ...params.images.map((image) => ({
              type: "image" as const,
              data: image.buffer.toString("base64"),
              mimeType: image.mime ?? "image/jpeg",
            })),
          ],
          timestamp: Date.now(),
        },
      ],
    };

    const maxTokens = resolveImageToolMaxTokens(model.maxTokens, params.maxTokens);
    const completeImage = async (retry = false) => {
      params.signal?.throwIfAborted();
      assertResourcesOpen?.();
      const payloadHandler = retry ? imageRetryPayloadHandler(onPayload) : onPayload;
      const timeoutMs = configuredTimeoutMs;
      const streamOptions = {
        apiKey,
        maxTokens,
        signal: requestSignal,
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        ...(requestModel.provider === "github-copilot"
          ? { headers: { "x-initiator": "user", "Copilot-Vision-Request": "true" } }
          : {}),
        ...(payloadHandler ? { onPayload: payloadHandler } : {}),
      };
      const task: Promise<AssistantMessage> = trackAsyncWork(() => {
        if (!providerStreamFn) {
          return complete(requestModel, context, streamOptions, assertResourcesOpen);
        }
        const stream = providerStreamFn(requestModel, context, streamOptions);
        // Acquire consumption before yielding so retirement cannot strand the returned stream.
        return runPluginStreamConsumer(stream, async () => await (await stream).result());
      });
      return await withImageDescriptionTimeout({
        controller,
        signal: params.signal,
        timeoutMs,
        createTimeoutError: (requestTimeoutMs) =>
          buildImageDescriptionTimeoutError({
            phase: "request",
            timeoutMs: requestTimeoutMs,
            setupDurationMs,
          }),
        task,
      });
    };

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

    params.signal?.throwIfAborted();
    const retryMessage = await completeImage(true);
    const text = coerceImageAssistantText({
      message: retryMessage,
      provider: model.provider,
      model: model.id,
    });
    return { text, model: model.id };
  });
}

function toImagesDescriptionRequest(params: ImageDescriptionRequest): ImagesDescriptionRequest {
  const {
    buffer,
    fileName,
    mime,
    signal,
    agentId,
    workspaceDir,
    preparedModelRuntime,
    ...request
  } = params;
  return {
    ...request,
    images: [{ buffer, fileName, mime }],
    ...(signal ? { signal } : {}),
    ...(agentId ? { agentId } : {}),
    ...(workspaceDir ? { workspaceDir } : {}),
    ...(preparedModelRuntime ? { preparedModelRuntime } : {}),
  };
}

export async function describeImagesWithModelCore(
  params: ImagesDescriptionRequest,
): Promise<ImagesDescriptionResult> {
  return await describeImagesWithModelPayloadTransformCore(params, undefined);
}

export async function describeImageWithModelCore(
  params: ImageDescriptionRequest,
): Promise<ImageDescriptionResult> {
  return await describeImagesWithModelCore(toImagesDescriptionRequest(params));
}

export async function describeImageWithModelPayloadTransformCore(
  params: ImageDescriptionRequest,
  onPayload: ProviderStreamOptions["onPayload"],
): Promise<ImageDescriptionResult> {
  return await describeImagesWithModelPayloadTransformCore(
    toImagesDescriptionRequest(params),
    onPayload,
  );
}

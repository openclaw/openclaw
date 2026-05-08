import type { Api, Context, Model, ProviderStreamOptions } from "@mariozechner/pi-ai";
import { complete } from "@mariozechner/pi-ai";
import { getApiKeyForModel, requireApiKey } from "../agents/model-auth.js";
import { normalizeModelRef } from "../agents/model-selection.js";
import { ensureOpenClawModelsJson } from "../agents/models-config.js";
import { resolveModelWithRegistry } from "../agents/pi-embedded-runner/model.js";
import { registerProviderStreamForModel } from "../agents/provider-stream.js";
import { prepareProviderDynamicModel } from "../plugins/provider-runtime.js";
import type { VideoUnderstandingRequest, VideoUnderstandingResult } from "./types.js";

let piModelDiscoveryRuntimePromise: Promise<
  typeof import("../agents/pi-model-discovery-runtime.js")
> | null = null;

function loadPiModelDiscoveryRuntime() {
  piModelDiscoveryRuntimePromise ??= import("../agents/pi-model-discovery-runtime.js");
  return piModelDiscoveryRuntimePromise;
}

function formatModelInputCapabilities(input: Model<Api>["input"] | undefined): string {
  return input && input.length > 0 ? input.join(", ") : "none";
}

async function resolveVideoRuntime(params: {
  cfg: VideoUnderstandingRequest["cfg"];
  agentDir: string;
  provider: string;
  model: string;
  profile?: string;
  preferredProfile?: string;
  authStore?: VideoUnderstandingRequest["authStore"];
}): Promise<{ apiKey: string; model: Model<Api> }> {
  await ensureOpenClawModelsJson(params.cfg, params.agentDir);
  const { discoverAuthStorage, discoverModels } = await loadPiModelDiscoveryRuntime();
  const authStorage = discoverAuthStorage(params.agentDir);
  const modelRegistry = discoverModels(authStorage, params.agentDir);
  const resolvedRef = normalizeModelRef(params.provider, params.model);

  let model = resolveModelWithRegistry({
    provider: resolvedRef.provider,
    modelId: resolvedRef.model,
    modelRegistry,
    cfg: params.cfg,
    agentDir: params.agentDir,
  }) as Model<Api> | null;

  if (!model) {
    await prepareProviderDynamicModel({
      provider: resolvedRef.provider,
      config: params.cfg,
      context: {
        config: params.cfg,
        agentDir: params.agentDir,
        provider: resolvedRef.provider,
        modelId: resolvedRef.model,
        modelRegistry,
      },
    });
    model = resolveModelWithRegistry({
      provider: resolvedRef.provider,
      modelId: resolvedRef.model,
      modelRegistry,
      cfg: params.cfg,
      agentDir: params.agentDir,
    }) as Model<Api> | null;
  }

  if (!model) {
    throw new Error(`Unknown model: ${resolvedRef.provider}/${resolvedRef.model}`);
  }

  // Check if model supports video (pi-ai Model type may not include 'video' in input,
  // but the model may still support it via native provider API)
  const modelInput = model.input as string[] | undefined;
  if (!modelInput?.includes("video")) {
    throw new Error(
      `Model does not support video: ${params.provider}/${params.model} ` +
        `(resolved ${model.provider}/${model.id} input: ${formatModelInputCapabilities(model.input)})`,
    );
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

function buildVideoContext(prompt: string, video: { buffer: Buffer; mime?: string }): Context {
  return {
    systemPrompt: prompt,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "video" as any,
            data: video.buffer.toString("base64"),
            mimeType: video.mime ?? "video/mp4",
          } as any,
        ],
        timestamp: Date.now(),
      },
    ],
  };
}

function coerceVideoAssistantText(message: unknown): string {
  if (!message || typeof message !== "object") {
    throw new Error("Video model returned invalid response");
  }
  const msg = message as { content?: Array<{ text?: string }> | string; text?: string };
  if (typeof msg.text === "string" && msg.text.trim()) {
    return msg.text.trim();
  }
  if (Array.isArray(msg.content)) {
    const text = msg.content
      .map((part) => (typeof part.text === "string" ? part.text.trim() : ""))
      .filter(Boolean)
      .join("\n")
      .trim();
    if (text) {
      return text;
    }
  }
  throw new Error("Video model returned no text");
}

function resolveVideoDescriptionTimeoutMs(
  requestedTimeoutMs: number | undefined,
  startedAtMs: number,
): number | undefined {
  if (typeof requestedTimeoutMs !== "number" || !Number.isFinite(requestedTimeoutMs)) {
    return 120_000; // Videos may take longer to process
  }
  const remaining = requestedTimeoutMs - (Date.now() - startedAtMs);
  return Math.max(1_000, remaining);
}

async function withVideoDescriptionTimeout<T>(params: {
  controller: AbortController;
  timeoutMs: number | undefined;
  task: Promise<T>;
}): Promise<T> {
  if (!params.timeoutMs) {
    return params.task;
  }
  const timer = setTimeout(() => params.controller.abort(), params.timeoutMs);
  try {
    return await params.task;
  } finally {
    clearTimeout(timer);
  }
}

export async function understandVideoWithModel(
  params: VideoUnderstandingRequest,
): Promise<VideoUnderstandingResult> {
  const prompt = params.prompt ?? "Analyze and describe this video content.";
  const startedAtMs = Date.now();
  const controller = new AbortController();

  const resolved = await withVideoDescriptionTimeout({
    controller,
    timeoutMs: resolveVideoDescriptionTimeoutMs(params.timeoutMs, startedAtMs),
    task: resolveVideoRuntime({
      cfg: params.cfg,
      agentDir: params.agentDir,
      provider: params.provider,
      model: params.model ?? "",
      profile: params.profile,
      preferredProfile: params.preferredProfile,
      authStore: params.authStore,
    }),
  });

  const { apiKey, model } = resolved;

  registerProviderStreamForModel({
    model,
    cfg: params.cfg,
    agentDir: params.agentDir,
  });

  const context = buildVideoContext(prompt, {
    buffer: params.buffer,
    mime: params.mime,
  });

  const timeoutMs = resolveVideoDescriptionTimeoutMs(params.timeoutMs, startedAtMs);
  const message = await withVideoDescriptionTimeout({
    controller,
    timeoutMs,
    task: complete(model, context, {
      apiKey,
      maxTokens: params.maxTokens ?? 4096,
      signal: controller.signal,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    }),
  });

  const text = coerceVideoAssistantText(message);
  return { text, model: model.id };
}

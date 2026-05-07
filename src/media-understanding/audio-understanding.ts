import type { Api, Context, Model, ProviderStreamOptions } from "@mariozechner/pi-ai";
import { complete } from "@mariozechner/pi-ai";
import { getApiKeyForModel, requireApiKey } from "../agents/model-auth.js";
import { normalizeModelRef } from "../agents/model-selection.js";
import { ensureOpenClawModelsJson } from "../agents/models-config.js";
import { resolveModelWithRegistry } from "../agents/pi-embedded-runner/model.js";
import { registerProviderStreamForModel } from "../agents/provider-stream.js";
import { prepareProviderDynamicModel } from "../plugins/provider-runtime.js";
import type { AudioUnderstandingRequest, AudioUnderstandingResult } from "./types.js";

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

async function resolveAudioRuntime(params: {
  cfg: AudioUnderstandingRequest["cfg"];
  agentDir: string;
  provider: string;
  model: string;
  profile?: string;
  preferredProfile?: string;
  authStore?: AudioUnderstandingRequest["authStore"];
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

  // Check if model supports audio (pi-ai Model type may not include 'audio' in input,
  // but the model may still support it via native provider API)
  const modelInput = model.input as string[] | undefined;
  if (!modelInput?.includes("audio")) {
    throw new Error(
      `Model does not support audio: ${params.provider}/${params.model} ` +
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

function buildAudioContext(prompt: string, audio: { buffer: Buffer; mime?: string }): Context {
  return {
    systemPrompt: prompt,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "audio" as any,
            data: audio.buffer.toString("base64"),
            mimeType: audio.mime ?? "audio/wav",
          } as any,
        ],
        timestamp: Date.now(),
      },
    ],
  };
}

function coerceAudioAssistantText(message: unknown): string {
  if (!message || typeof message !== "object") {
    throw new Error("Audio model returned invalid response");
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
  throw new Error("Audio model returned no text");
}

function resolveAudioDescriptionTimeoutMs(
  requestedTimeoutMs: number | undefined,
  startedAtMs: number,
): number | undefined {
  if (typeof requestedTimeoutMs !== "number" || !Number.isFinite(requestedTimeoutMs)) {
    return 60_000;
  }
  const remaining = requestedTimeoutMs - (Date.now() - startedAtMs);
  return Math.max(1_000, remaining);
}

async function withAudioDescriptionTimeout<T>(params: {
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

export async function understandAudioWithModel(
  params: AudioUnderstandingRequest,
): Promise<AudioUnderstandingResult> {
  const prompt = params.prompt ?? "Analyze and describe this audio content.";
  const startedAtMs = Date.now();
  const controller = new AbortController();

  const resolved = await withAudioDescriptionTimeout({
    controller,
    timeoutMs: resolveAudioDescriptionTimeoutMs(params.timeoutMs, startedAtMs),
    task: resolveAudioRuntime({
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

  const context = buildAudioContext(prompt, {
    buffer: params.buffer,
    mime: params.mime,
  });

  const timeoutMs = resolveAudioDescriptionTimeoutMs(params.timeoutMs, startedAtMs);
  const message = await withAudioDescriptionTimeout({
    controller,
    timeoutMs,
    task: complete(model, context, {
      apiKey,
      maxTokens: params.maxTokens ?? 4096,
      signal: controller.signal,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    }),
  });

  const text = coerceAudioAssistantText(message);
  return { text, model: model.id };
}

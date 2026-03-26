import type { AuthProfileStore } from "../agents/auth-profiles.js";
import { describeFailoverError, isFailoverError } from "../agents/failover-error.js";
import type { FallbackAttempt } from "../agents/model-fallback.types.js";
import type { OpenClawConfig } from "../config/config.js";
import {
  resolveAgentModelFallbackValues,
  resolveAgentModelPrimaryValue,
} from "../config/model-input.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getProviderEnvVars } from "../secrets/provider-env-vars.js";
import { parseImageGenerationModelRef } from "./model-ref.js";
import { getImageGenerationProvider, listImageGenerationProviders } from "./provider-registry.js";
import type {
  GeneratedImageAsset,
  ImageGenerationResolution,
  ImageGenerationResult,
  ImageGenerationSourceImage,
} from "./types.js";

const log = createSubsystemLogger("image-generation");

export type GenerateImageParams = {
  cfg: OpenClawConfig;
  prompt: string;
  agentDir?: string;
  authStore?: AuthProfileStore;
  modelOverride?: string;
  count?: number;
  size?: string;
  aspectRatio?: string;
  resolution?: ImageGenerationResolution;
  inputImages?: ImageGenerationSourceImage[];
};

export type GenerateImageRuntimeResult = {
  images: GeneratedImageAsset[];
  provider: string;
  model: string;
  attempts: FallbackAttempt[];
  metadata?: Record<string, unknown>;
};

function resolveImageGenerationCandidates(params: {
  cfg: OpenClawConfig;
  modelOverride?: string;
}): Array<{ provider: string; model: string }> {
  const candidates: Array<{ provider: string; model: string }> = [];
  const seen = new Set<string>();
  const add = (raw: string | undefined) => {
    const parsed = parseImageGenerationModelRef(raw);
    if (!parsed) {
      return;
    }
    const key = `${parsed.provider}/${parsed.model}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    candidates.push(parsed);
  };

  add(params.modelOverride);
  add(resolveAgentModelPrimaryValue(params.cfg.agents?.defaults?.imageGenerationModel));
  for (const fallback of resolveAgentModelFallbackValues(
    params.cfg.agents?.defaults?.imageGenerationModel,
  )) {
    add(fallback);
  }
  return candidates;
}

function throwImageGenerationFailure(params: {
  attempts: FallbackAttempt[];
  lastError: unknown;
}): never {
  if (params.attempts.length <= 1 && params.lastError) {
    throw params.lastError;
  }
  const summary =
    params.attempts.length > 0
      ? params.attempts
          .map((attempt) => `${attempt.provider}/${attempt.model}: ${attempt.error}`)
          .join(" | ")
      : "unknown";
  throw new Error(`All image generation models failed (${params.attempts.length}): ${summary}`, {
    cause: params.lastError instanceof Error ? params.lastError : undefined,
  });
}

function buildNoImageGenerationModelConfiguredMessage(cfg: OpenClawConfig): string {
  const providers = listImageGenerationProviders(cfg);
  const sampleModel =
    providers.find((provider) => provider.defaultModel) ??
    ({ id: "google", defaultModel: "gemini-3-pro-image-preview" } as const);
  const authHints = providers
    .flatMap((provider) => {
      const envVars = getProviderEnvVars(provider.id);
      if (envVars.length === 0) {
        return [];
      }
      return [`${provider.id}: ${envVars.join(" / ")}`];
    })
    .slice(0, 3);
  return [
    `No image-generation model configured. Set agents.defaults.imageGenerationModel.primary to a provider/model like "${sampleModel.id}/${sampleModel.defaultModel}".`,
    authHints.length > 0
      ? `If you want a specific provider, also configure that provider's auth/API key first (${authHints.join("; ")}).`
      : "If you want a specific provider, also configure that provider's auth/API key first.",
  ].join(" ");
}

export function listRuntimeImageGenerationProviders(params?: { config?: OpenClawConfig }) {
  return listImageGenerationProviders(params?.config);
}

export async function generateImage(
  params: GenerateImageParams,
): Promise<GenerateImageRuntimeResult> {
  const candidates = resolveImageGenerationCandidates({
    cfg: params.cfg,
    modelOverride: params.modelOverride,
  });
  if (candidates.length === 0) {
    throw new Error(buildNoImageGenerationModelConfiguredMessage(params.cfg));
  }

  const attempts: FallbackAttempt[] = [];
  let lastError: unknown;

  for (const candidate of candidates) {
    const provider = getImageGenerationProvider(candidate.provider, params.cfg);
    if (!provider) {
      const error = `No image-generation provider registered for ${candidate.provider}`;
      attempts.push({
        provider: candidate.provider,
        model: candidate.model,
        error,
      });
      lastError = new Error(error);
      continue;
    }

    try {
      const result: ImageGenerationResult = await provider.generateImage({
        provider: candidate.provider,
        model: candidate.model,
        prompt: params.prompt,
        cfg: params.cfg,
        agentDir: params.agentDir,
        authStore: params.authStore,
        count: params.count,
        size: params.size,
        aspectRatio: params.aspectRatio,
        resolution: params.resolution,
        inputImages: params.inputImages,
      });
      if (!Array.isArray(result.images) || result.images.length === 0) {
        throw new Error("Image generation provider returned no images.");
      }
      return {
        images: result.images,
        provider: candidate.provider,
        model: result.model ?? candidate.model,
        attempts,
        metadata: result.metadata,
      };
    } catch (err) {
      lastError = err;
      const described = isFailoverError(err) ? describeFailoverError(err) : undefined;
      attempts.push({
        provider: candidate.provider,
        model: candidate.model,
        error: described?.message ?? (err instanceof Error ? err.message : String(err)),
        reason: described?.reason,
        status: described?.status,
        code: described?.code,
      });
      log.debug(`image-generation candidate failed: ${candidate.provider}/${candidate.model}`);
    }
  }

  throwImageGenerationFailure({ attempts, lastError });
}

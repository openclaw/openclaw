import type { AuthProfileStore } from "../agents/auth-profiles.js";
import { describeFailoverError, isFailoverError } from "../agents/failover-error.js";
import type { FallbackAttempt } from "../agents/model-fallback.types.js";
import type { OpenClawConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getVideoGenerationProvider, listVideoGenerationProviders } from "./provider-registry.js";
import type { GeneratedVideoAsset, VideoGenerationResult } from "./types.js";

const log = createSubsystemLogger("video-generation");

export type GenerateVideoParams = {
  cfg: OpenClawConfig;
  prompt: string;
  agentDir?: string;
  authStore?: AuthProfileStore;
  modelOverride?: string;
  durationSeconds?: number;
  aspectRatio?: string;
  resolution?: string;
  seed?: number;
  watermark?: boolean;
  firstFrameImageUrl?: string;
  lastFrameImageUrl?: string;
  providerOptions?: Record<string, unknown>;
};

export type GenerateVideoRuntimeResult = {
  videos: GeneratedVideoAsset[];
  provider: string;
  model: string;
  attempts: FallbackAttempt[];
  metadata?: Record<string, unknown>;
};

function parseModelRef(raw: string | undefined): { provider: string; model: string } | null {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return null;
  }
  const slashIndex = trimmed.indexOf("/");
  if (slashIndex <= 0 || slashIndex === trimmed.length - 1) {
    return null;
  }
  return {
    provider: trimmed.slice(0, slashIndex).trim(),
    model: trimmed.slice(slashIndex + 1).trim(),
  };
}

function resolveVideoGenerationCandidates(params: {
  cfg: OpenClawConfig;
  modelOverride?: string;
}): Array<{ provider: string; model: string }> {
  const candidates: Array<{ provider: string; model: string }> = [];
  const seen = new Set<string>();
  const add = (raw: string | undefined) => {
    const parsed = parseModelRef(raw);
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

  // Fall back to first registered provider's default model
  if (candidates.length === 0) {
    const providers = listVideoGenerationProviders(params.cfg);
    for (const provider of providers) {
      if (provider.defaultModel) {
        add(`${provider.id}/${provider.defaultModel}`);
        break;
      }
    }
  }

  return candidates;
}

function throwVideoGenerationFailure(params: {
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
  throw new Error(`All video generation models failed (${params.attempts.length}): ${summary}`, {
    cause: params.lastError instanceof Error ? params.lastError : undefined,
  });
}

export function listRuntimeVideoGenerationProviders(params?: { config?: OpenClawConfig }) {
  return listVideoGenerationProviders(params?.config);
}

export async function generateVideo(
  params: GenerateVideoParams,
): Promise<GenerateVideoRuntimeResult> {
  const candidates = resolveVideoGenerationCandidates({
    cfg: params.cfg,
    modelOverride: params.modelOverride,
  });
  if (candidates.length === 0) {
    throw new Error(
      "No video-generation model configured. Install a provider plugin that supports video generation (e.g. @openclaw/byteplus-provider).",
    );
  }

  const attempts: FallbackAttempt[] = [];
  let lastError: unknown;

  for (const candidate of candidates) {
    const provider = getVideoGenerationProvider(candidate.provider, params.cfg);
    if (!provider) {
      const error = `No video-generation provider registered for ${candidate.provider}`;
      attempts.push({ provider: candidate.provider, model: candidate.model, error });
      lastError = new Error(error);
      continue;
    }

    try {
      const result: VideoGenerationResult = await provider.generateVideo({
        provider: candidate.provider,
        model: candidate.model,
        prompt: params.prompt,
        cfg: params.cfg,
        agentDir: params.agentDir,
        authStore: params.authStore,
        durationSeconds: params.durationSeconds,
        aspectRatio: params.aspectRatio,
        resolution: params.resolution,
        seed: params.seed,
        watermark: params.watermark,
        firstFrameImage: params.firstFrameImageUrl
          ? { url: params.firstFrameImageUrl, role: "first_frame" }
          : undefined,
        lastFrameImage: params.lastFrameImageUrl
          ? { url: params.lastFrameImageUrl, role: "last_frame" }
          : undefined,
        providerOptions: params.providerOptions,
      });
      if (!Array.isArray(result.videos) || result.videos.length === 0) {
        throw new Error("Video generation provider returned no videos.");
      }
      return {
        videos: result.videos,
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
      log.debug(`video-generation candidate failed: ${candidate.provider}/${candidate.model}`);
    }
  }

  throwVideoGenerationFailure({ attempts, lastError });
}

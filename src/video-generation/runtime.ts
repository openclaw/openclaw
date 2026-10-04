// Video generation runtime coordinates provider auth, fallbacks, and job polling.
import { resolveAgentModelTimeoutMsValue } from "../config/model-input.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { createMediaProviderLookup } from "../media-generation/provider-registry.js";
import {
  getVideoGenerationProvider,
  listVideoGenerationProviders,
  withVideoGenerationProviders,
} from "../media-generation/registry.js";
import {
  buildMediaGenerationNormalizationMetadata,
  resolveMediaProviderRequestTimeoutMs,
  runMediaGenerationCandidates,
} from "../media-generation/runtime-shared.js";
import { getProviderEnvVarsCore } from "../secrets/provider-env-vars.js";
import { resolveVideoGenerationModeCapabilities } from "./capabilities.js";
import {
  buildVideoGenerationCapabilityFailure,
  resolveProviderWithModelCapabilities,
} from "./capability-overlays.js";
import { resolveVideoGenerationSupportedDurations } from "./duration-support.js";
import { resolveVideoGenerationOverrides } from "./normalization.js";
import type { GenerateVideoParams, GenerateVideoRuntimeResult } from "./runtime-types.js";
import type { VideoGenerationProviderOptionType, VideoGenerationResult } from "./types.js";

const log = createSubsystemLogger("video-generation");
const MODEL_CAPABILITY_LOOKUP_TIMEOUT_MS = 5_000;
// Internal request hint for providers that perform their own final snapping.
const SUPPORTED_DURATIONS_HINT = Symbol.for("openclaw.videoGeneration.supportedDurations");

type VideoGenerationRuntimeDeps = {
  getProvider?: typeof getVideoGenerationProvider;
  listProviders?: typeof listVideoGenerationProviders;
  getProviderEnvVars?: typeof getProviderEnvVarsCore;
  log?: Pick<typeof log, "debug" | "warn">;
};

export type { GenerateVideoParams, GenerateVideoRuntimeResult } from "./runtime-types.js";

/**
 * Missing declarations preserve legacy providerOptions passthrough; an empty
 * declaration rejects options. Declared keys require their specified types.
 */
function validateProviderOptionsAgainstDeclaration(params: {
  providerId: string;
  model: string;
  providerOptions: Record<string, unknown>;
  declaration: Readonly<Record<string, VideoGenerationProviderOptionType>> | undefined;
}): string | undefined {
  const { providerId, model, providerOptions, declaration } = params;
  const keys = Object.keys(providerOptions);
  if (keys.length === 0 || declaration === undefined) {
    return undefined;
  }
  if (Object.keys(declaration).length === 0) {
    return `${providerId}/${model} does not accept providerOptions (caller supplied: ${keys.join(", ")}); skipping`;
  }
  const unknown = keys.filter((key) => !Object.hasOwn(declaration, key));
  if (unknown.length > 0) {
    const accepted = Object.keys(declaration).join(", ");
    return `${providerId}/${model} does not accept providerOptions keys: ${unknown.join(", ")} (accepted: ${accepted}); skipping`;
  }
  for (const key of keys) {
    const expected = declaration[key];
    const value = providerOptions[key];
    const actual = typeof value;
    if (expected === "number" && (actual !== "number" || !Number.isFinite(value))) {
      return `${providerId}/${model} expects providerOptions.${key} to be a finite number, got ${actual}; skipping`;
    }
    if (expected === "boolean" && actual !== "boolean") {
      return `${providerId}/${model} expects providerOptions.${key} to be a boolean, got ${actual}; skipping`;
    }
    if (expected === "string" && actual !== "string") {
      return `${providerId}/${model} expects providerOptions.${key} to be a string, got ${actual}; skipping`;
    }
  }
  return undefined;
}

export function listRuntimeVideoGenerationProviders(
  params?: { config?: OpenClawConfig },
  deps: VideoGenerationRuntimeDeps = {},
) {
  return (deps.listProviders ?? listVideoGenerationProviders)(params?.config);
}

export async function generateVideo(
  params: GenerateVideoParams,
  deps: VideoGenerationRuntimeDeps = {},
): Promise<GenerateVideoRuntimeResult> {
  if (deps.getProvider && deps.listProviders) {
    return runVideoGeneration(params, deps);
  }
  return withVideoGenerationProviders(params.cfg, (providers) => {
    const lookup = createMediaProviderLookup(providers);
    return runVideoGeneration(params, {
      ...deps,
      getProvider: deps.getProvider ?? lookup.getProvider,
      listProviders: deps.listProviders ?? lookup.listProviders,
    });
  });
}

async function runVideoGeneration(
  params: GenerateVideoParams,
  deps: VideoGenerationRuntimeDeps,
): Promise<GenerateVideoRuntimeResult> {
  const getProvider = deps.getProvider ?? getVideoGenerationProvider;
  const listProviders = deps.listProviders ?? listVideoGenerationProviders;
  const logger = deps.log ?? log;
  const requestedTimeoutMs =
    params.timeoutMs ??
    resolveAgentModelTimeoutMsValue(params.cfg.agents?.defaults?.mediaModels?.video);

  let skipWarnEmitted = false;
  const warnOnFirstSkip = (reason: string) => {
    // Only the first skipped candidate warrants a warning; callers log the rest at debug.
    if (!skipWarnEmitted) {
      skipWarnEmitted = true;
      logger.warn(`video-generation candidate skipped: ${reason}`);
    }
  };

  return runMediaGenerationCandidates({
    request: params,
    listProviders,
    getProviderEnvVars: deps.getProviderEnvVars,
    capability: "video",
    getProvider: (providerId) => getProvider(providerId, params.cfg),
    onFailure: (attempt) => {
      logger.warn(
        `video-generation candidate failed: ${attempt.provider}/${attempt.model}: ${attempt.error}`,
      );
    },
    async prepareCandidate(candidate, provider) {
      const timeoutMs = resolveMediaProviderRequestTimeoutMs({
        timeoutMs: requestedTimeoutMs,
        providerDefaultTimeoutMs: provider.defaultTimeoutMs,
      });
      const activeProvider = await resolveProviderWithModelCapabilities({
        provider,
        providerId: candidate.provider,
        model: candidate.model,
        cfg: params.cfg,
        agentDir: params.agentDir,
        authStore: params.authStore,
        timeoutMs: MODEL_CAPABILITY_LOOKUP_TIMEOUT_MS,
        log: logger,
      });

      // Guard: catalog modes and reference counts are authoritative before I/O,
      // so fallback cannot select a model that will reject or drop the request.
      const inputImageCount = params.inputImages?.length ?? 0;
      const inputVideoCount = params.inputVideos?.length ?? 0;
      const inputAudioCount = params.inputAudios?.length ?? 0;
      const capabilityMismatch = buildVideoGenerationCapabilityFailure({
        providerId: candidate.provider,
        model: candidate.model,
        provider: activeProvider,
        inputImageCount,
        inputVideoCount,
        inputAudioCount,
      });
      if (capabilityMismatch) {
        warnOnFirstSkip(capabilityMismatch);
        logger.debug(
          `video-generation candidate skipped (mode or reference capability): ${candidate.provider}/${candidate.model}`,
        );
        return capabilityMismatch;
      }

      const { capabilities: modeCapabilities } = resolveVideoGenerationModeCapabilities({
        provider: activeProvider,
        model: candidate.model,
        inputImageCount,
        inputVideoCount,
      });
      if (params.providerOptions) {
        const declaredOptions =
          modeCapabilities?.providerOptions ?? activeProvider.capabilities.providerOptions;
        const mismatch = validateProviderOptionsAgainstDeclaration({
          providerId: candidate.provider,
          model: candidate.model,
          providerOptions: params.providerOptions,
          declaration: declaredOptions,
        });
        if (mismatch) {
          warnOnFirstSkip(mismatch);
          logger.debug(
            `video-generation candidate skipped (providerOptions): ${candidate.provider}/${candidate.model}`,
          );
          return mismatch;
        }
      }

      // Explicit duration lists use normalization's nearest-value snapping instead of this cap.
      const supportedDurations = resolveVideoGenerationSupportedDurations({
        provider: activeProvider,
        model: candidate.model,
        inputImageCount,
        inputVideoCount,
      });
      const requestedDuration = params.durationSeconds;
      if (typeof requestedDuration === "number" && Number.isFinite(requestedDuration)) {
        const maxDuration =
          modeCapabilities?.maxDurationSeconds ?? activeProvider.capabilities.maxDurationSeconds;
        if (
          !supportedDurations &&
          typeof maxDuration === "number" &&
          // Compare the normalized (rounded) duration, not the raw float, since
          // resolveVideoGenerationOverrides applies Math.round before sending to the provider.
          // A request for 4.4s against maxDurationSeconds=4 rounds to 4 and is valid.
          Math.round(requestedDuration) > maxDuration
        ) {
          const error = `${candidate.provider}/${candidate.model} supports at most ${maxDuration}s per video, ${requestedDuration}s requested; skipping`;
          warnOnFirstSkip(error);
          logger.debug(
            `video-generation candidate skipped (duration capability): ${candidate.provider}/${candidate.model}`,
          );
          return error;
        }
      }

      return async (attempts): Promise<GenerateVideoRuntimeResult> => {
        const sanitized = resolveVideoGenerationOverrides({
          provider: activeProvider,
          model: candidate.model,
          size: params.size,
          aspectRatio: params.aspectRatio,
          resolution: params.resolution,
          durationSeconds: params.durationSeconds,
          audio: params.audio,
          watermark: params.watermark,
          inputImageCount,
          inputVideoCount,
        });
        const generationRequest: Parameters<typeof provider.generateVideo>[0] & {
          [SUPPORTED_DURATIONS_HINT]?: readonly number[];
        } = {
          provider: candidate.provider,
          model: candidate.model,
          prompt: params.prompt,
          cfg: params.cfg,
          agentDir: params.agentDir,
          authStore: params.authStore,
          size: sanitized.size,
          aspectRatio: sanitized.aspectRatio,
          resolution: sanitized.resolution,
          durationSeconds: sanitized.durationSeconds,
          audio: sanitized.audio,
          watermark: sanitized.watermark,
          inputImages: params.inputImages,
          inputVideos: params.inputVideos,
          inputAudios: params.inputAudios,
          providerOptions: params.providerOptions,
          ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        };
        if (supportedDurations) {
          generationRequest[SUPPORTED_DURATIONS_HINT] = supportedDurations;
        }
        const result: VideoGenerationResult = await provider.generateVideo(generationRequest);
        if (!Array.isArray(result.videos) || result.videos.length === 0) {
          throw new Error("Video generation provider returned no videos.");
        }
        const videos = result.videos.map((video, index) => {
          if (video.buffer?.byteLength === 0) {
            if (video.url) {
              // URL-only video is valid; remove the unusable buffer so callers do not
              // prefer it and persist zero bytes instead of delivering the URL.
              const { buffer: _emptyBuffer, ...urlOnlyVideo } = video;
              return urlOnlyVideo;
            }
            throw new Error(
              `Video generation provider returned an empty video buffer at index ${index}.`,
            );
          }
          if (!video.buffer && !video.url) {
            throw new Error(
              `Video generation provider returned an undeliverable asset at index ${index}: neither buffer nor url is set.`,
            );
          }
          return video;
        });
        return {
          videos,
          provider: candidate.provider,
          model: result.model ?? candidate.model,
          attempts,
          normalization: sanitized.normalization,
          ignoredOverrides: sanitized.ignoredOverrides,
          metadata: {
            ...result.metadata,
            ...buildMediaGenerationNormalizationMetadata({
              normalization: sanitized.normalization,
              requestedSizeForDerivedAspectRatio: params.size,
              includeSupportedDurationSeconds: true,
            }),
          },
        };
      };
    },
  });
}

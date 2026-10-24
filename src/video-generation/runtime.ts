import { resolveAgentModelTimeoutMsValue } from "../config/model-input.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveMediaGeometryOverrides } from "../media-generation/geometry-normalization.js";
import { createMediaProviderLookup } from "../media-generation/provider-registry.js";
import {
  getVideoGenerationProvider,
  listVideoGenerationProviders,
} from "../media-generation/registry.js";
import {
  buildMediaGenerationNormalizationMetadata,
  resolveMediaProviderRequestTimeoutMs,
  runMediaGenerationCandidates,
} from "../media-generation/runtime-shared.js";
import { withAcquiredPluginCapabilityProviders } from "../plugins/capability-provider-acquisition.js";
import { getProviderEnvVarsCore } from "../secrets/provider-env-vars.js";
import { resolveVideoGenerationModeCapabilities } from "./capabilities.js";
import {
  normalizeVideoGenerationDuration,
  resolveVideoGenerationSupportedDurations,
  selectSupportedVideoDuration,
} from "./duration-support.js";
import type { GenerateVideoParams, GenerateVideoRuntimeResult } from "./runtime-types.js";
import type {
  VideoGenerationIgnoredOverride,
  VideoGenerationModeCapabilities,
  VideoGenerationNormalization,
  VideoGenerationProviderCapabilities,
  VideoGenerationResult,
  VideoGenerationTransformCapabilities,
} from "./types.js";

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

function mergeVideoGenerationCapabilities<T extends VideoGenerationModeCapabilities>(
  base: T,
  overlay: T,
): T {
  const overlayOptions = overlay.providerOptions;
  // Explicit empty providerOptions means "clear inherited options"; undefined
  // means "inherit base declaration".
  const mergedProviderOptions =
    Object.hasOwn(overlay, "providerOptions") &&
    overlayOptions &&
    Object.keys(overlayOptions).length === 0
      ? overlayOptions
      : base.providerOptions || overlayOptions
        ? {
            ...base.providerOptions,
            ...overlayOptions,
          }
        : undefined;
  return {
    ...base,
    ...overlay,
    ...(mergedProviderOptions ? { providerOptions: mergedProviderOptions } : {}),
  };
}

function mergeVideoGenerationModeCapabilities<
  T extends VideoGenerationModeCapabilities | VideoGenerationTransformCapabilities | undefined,
>(base: T, overlay: T): T {
  if (!overlay) {
    return base;
  }
  if (!base) {
    return overlay;
  }
  return mergeVideoGenerationCapabilities(base, overlay);
}

function mergeVideoGenerationProviderCapabilities(
  base: VideoGenerationProviderCapabilities,
  overlay: VideoGenerationProviderCapabilities,
): VideoGenerationProviderCapabilities {
  return {
    ...mergeVideoGenerationCapabilities(base, overlay),
    generate: mergeVideoGenerationModeCapabilities(base.generate, overlay.generate),
    imageToVideo: mergeVideoGenerationModeCapabilities(base.imageToVideo, overlay.imageToVideo),
    videoToVideo: mergeVideoGenerationModeCapabilities(base.videoToVideo, overlay.videoToVideo),
  };
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
  return withAcquiredPluginCapabilityProviders(
    { key: "videoGenerationProviders", cfg: params.cfg },
    (providers) => {
      const lookup = createMediaProviderLookup(providers);
      return runVideoGeneration(params, {
        ...deps,
        getProvider: deps.getProvider ?? lookup.getProvider,
        listProviders: deps.listProviders ?? lookup.listProviders,
      });
    },
  );
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
    // Warn once; the coordinator retains every skipped candidate in attempts.
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
      const resolveActiveProvider = async () => {
        if (!provider.resolveModelCapabilities) {
          return provider;
        }
        try {
          const modelCapabilities = await provider.resolveModelCapabilities({
            provider: candidate.provider,
            model: candidate.model,
            cfg: params.cfg,
            agentDir: params.agentDir,
            authStore: params.authStore,
            timeoutMs: MODEL_CAPABILITY_LOOKUP_TIMEOUT_MS,
          });
          if (!modelCapabilities) {
            return provider;
          }
          // Keep dynamic model capabilities local to this request/candidate.
          return {
            ...provider,
            capabilities: mergeVideoGenerationProviderCapabilities(
              provider.capabilities,
              modelCapabilities,
            ),
          };
        } catch (err) {
          logger.debug(
            `video-generation model capability lookup failed for ${candidate.provider}/${candidate.model}: ${err instanceof Error ? err.message : String(err)}`,
          );
          return provider;
        }
      };
      const activeProvider = await resolveActiveProvider();

      // Guard: catalog modes and reference counts are authoritative before I/O,
      // so fallback cannot select a model that will reject or drop the request.
      const inputImageCount = params.inputImages?.length ?? 0;
      const inputVideoCount = params.inputVideos?.length ?? 0;
      const inputAudioCount = params.inputAudios?.length ?? 0;
      const buildCapabilityFailure = (): string | undefined => {
        const label = `${candidate.provider}/${candidate.model}`;
        const { mode, capabilities } = resolveVideoGenerationModeCapabilities({
          provider: activeProvider,
          model: candidate.model,
          inputImageCount,
          inputVideoCount,
        });
        const catalogModes = activeProvider.catalogByModel?.[candidate.model]?.modes;
        if (mode && catalogModes && !catalogModes.includes(mode)) {
          const modeLabel =
            mode === "generate"
              ? "text-to-video generation"
              : mode === "imageToVideo"
                ? "image-to-video generation"
                : "video-to-video generation";
          return `${label} does not support ${modeLabel}; skipping`;
        }
        if (inputImageCount > 0 || inputVideoCount > 0) {
          // Reference inputs must be explicitly supported; never silently drop assets.
          const visualLabel =
            inputImageCount > 0 && inputVideoCount > 0
              ? "combined image/video reference inputs"
              : inputImageCount > 0
                ? "reference image inputs"
                : "reference video inputs";
          if (!capabilities || !("enabled" in capabilities) || !capabilities.enabled) {
            return `${label} does not support ${visualLabel}; skipping to avoid silent reference drop`;
          }
        }
        for (const [kind, count, limitKey] of [
          ["image", inputImageCount, "maxInputImages"],
          ["video", inputVideoCount, "maxInputVideos"],
          ["audio", inputAudioCount, "maxInputAudios"],
        ] as const) {
          const limit = capabilities?.[limitKey] ?? activeProvider.capabilities[limitKey] ?? 0;
          if (count > 0 && count > limit) {
            return limit === 0
              ? `${label} does not support reference ${kind} inputs; skipping to avoid silent ${kind} drop`
              : `${label} supports at most ${limit} reference ${kind}(s), ${count} requested; skipping`;
          }
        }
        return undefined;
      };
      const capabilityMismatch = buildCapabilityFailure();
      if (capabilityMismatch) {
        warnOnFirstSkip(capabilityMismatch);
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
        const providerOptions = params.providerOptions;
        // Missing declarations preserve passthrough; an empty declaration rejects options.
        const validateProviderOptions = (): string | undefined => {
          const label = `${candidate.provider}/${candidate.model}`;
          const keys = Object.keys(providerOptions);
          if (keys.length === 0 || declaredOptions === undefined) {
            return undefined;
          }
          if (Object.keys(declaredOptions).length === 0) {
            return `${label} does not accept providerOptions (caller supplied: ${keys.join(", ")}); skipping`;
          }
          const unknown = keys.filter((key) => !Object.hasOwn(declaredOptions, key));
          if (unknown.length > 0) {
            const accepted = Object.keys(declaredOptions).join(", ");
            return `${label} does not accept providerOptions keys: ${unknown.join(", ")} (accepted: ${accepted}); skipping`;
          }
          for (const key of keys) {
            const expected = declaredOptions[key];
            const value = providerOptions[key];
            const actual = typeof value;
            if (expected === "number" && (typeof value !== "number" || !Number.isFinite(value))) {
              return `${label} expects providerOptions.${key} to be a finite number, got ${actual}; skipping`;
            }
            if (expected === "boolean" && actual !== "boolean") {
              return `${label} expects providerOptions.${key} to be a boolean, got ${actual}; skipping`;
            }
            if (expected === "string" && actual !== "string") {
              return `${label} expects providerOptions.${key} to be a string, got ${actual}; skipping`;
            }
          }
          return undefined;
        };
        const mismatch = validateProviderOptions();
        if (mismatch) {
          warnOnFirstSkip(mismatch);
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
          // Normalization applies Math.round before sending to the provider.
          // A request for 4.4s against maxDurationSeconds=4 rounds to 4 and is valid.
          Math.round(requestedDuration) > maxDuration
        ) {
          const error = `${candidate.provider}/${candidate.model} supports at most ${maxDuration}s per video, ${requestedDuration}s requested; skipping`;
          warnOnFirstSkip(error);
          return error;
        }
      }

      return async (attempts): Promise<GenerateVideoRuntimeResult> => {
        const sanitized = resolveMediaGeometryOverrides({
          size: params.size,
          aspectRatio: params.aspectRatio,
          resolution: params.resolution,
          capabilities: modeCapabilities,
          reportUnrecognizedOverrides: true,
          useAspectRatioForRequestedSize: true,
        });
        const ignoredOverrides: VideoGenerationIgnoredOverride[] = sanitized.ignoredOverrides;
        const normalization: VideoGenerationNormalization = sanitized.normalization;
        let { audio, watermark } = params;
        if (modeCapabilities && typeof audio === "boolean" && !modeCapabilities.supportsAudio) {
          ignoredOverrides.push({ key: "audio", value: audio });
          audio = undefined;
        }
        if (
          modeCapabilities &&
          typeof watermark === "boolean" &&
          !modeCapabilities.supportsWatermark
        ) {
          ignoredOverrides.push({ key: "watermark", value: watermark });
          watermark = undefined;
        }
        const requestedDurationSeconds = normalizeVideoGenerationDuration({
          durationSeconds: params.durationSeconds,
        });
        const durationSeconds =
          requestedDurationSeconds !== undefined && supportedDurations
            ? selectSupportedVideoDuration(requestedDurationSeconds, supportedDurations)
            : requestedDurationSeconds;
        if (
          typeof requestedDurationSeconds === "number" &&
          typeof durationSeconds === "number" &&
          requestedDurationSeconds !== durationSeconds
        ) {
          normalization.durationSeconds = {
            requested: requestedDurationSeconds,
            applied: durationSeconds,
            ...(supportedDurations?.length ? { supportedValues: supportedDurations } : {}),
          };
        }
        const appliedNormalization = Object.keys(normalization).length ? normalization : undefined;
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
          durationSeconds,
          audio,
          watermark,
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
          normalization: appliedNormalization,
          ignoredOverrides,
          metadata: {
            ...result.metadata,
            ...buildMediaGenerationNormalizationMetadata({
              normalization: appliedNormalization,
              requestedSizeForDerivedAspectRatio: params.size,
              includeSupportedDurationSeconds: true,
            }),
          },
        };
      };
    },
  });
}

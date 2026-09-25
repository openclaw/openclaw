/** Model selection, compression preparation, and provider execution for view_image. */
import { findCapabilityProviderById } from "../../../packages/media-generation-core/src/capability-model-ref.js";
import { normalizeMediaProviderId } from "../../../packages/media-understanding-common/src/provider-id.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { MediaUnderstandingModelConfig } from "../../config/types.tools.js";
import { DEFAULT_TIMEOUT_SECONDS } from "../../media-understanding/defaults.js";
import { matchesMediaEntryCapability } from "../../media-understanding/entry-capabilities.js";
import type {
  buildMediaUnderstandingRegistry,
  getMediaUnderstandingProvider,
} from "../../media-understanding/provider-registry.js";
import { resolveTimeoutMs } from "../../media-understanding/resolve.js";
import type { ImageCompressionPolicy } from "../../media/web-media.js";
import type {
  describeImageWithModel,
  describeImagesWithModel,
  MediaUnderstandingProvider,
} from "../../plugin-sdk/media-understanding.js";
import { runWithAsyncWorkResources } from "../../shared/async-work-resources.js";
import {
  bindOperatorModelExecution,
  type AdmittedRunOperatorAuthority,
} from "../admitted-run-context.js";
import type { AuthProfileStore } from "../auth-profiles/types.js";
import { resolveImageCompressionModelPolicy } from "../image-compression-policy.js";
import {
  resolveAllowedImageFallbackCandidates,
  runWithImageModelFallback,
} from "../model-fallback-image.js";
import type { PreparedModelRuntimeSnapshot } from "../prepared-model-runtime.js";
import { resolveConfiguredImageModelRefs, type ImageModelConfig } from "./image-tool.helpers.js";
import { applyAgentDefaultModelConfig } from "./model-config.helpers.js";

type ImageModelExecutionDeps = {
  buildProviderRegistry: typeof buildMediaUnderstandingRegistry;
  getMediaUnderstandingProvider: typeof getMediaUnderstandingProvider;
  describeImageWithModel: typeof describeImageWithModel;
  describeImagesWithModel: typeof describeImagesWithModel;
  resolveModelAsync: (typeof import("../embedded-agent-runner/model.js"))["resolveModelAsync"];
  resolveRegisteredMediaUnderstandingProvider: (params: {
    providerId: string;
    cfg?: OpenClawConfig;
  }) => MediaUnderstandingProvider | undefined;
};

export function resolveImageToolMaxTokens(
  modelMaxTokens: number | undefined,
  requestedMaxTokens = 4096,
) {
  if (
    typeof modelMaxTokens !== "number" ||
    !Number.isFinite(modelMaxTokens) ||
    modelMaxTokens <= 0
  ) {
    return requestedMaxTokens;
  }
  return Math.min(requestedMaxTokens, modelMaxTokens);
}

export function resolveImageModelConfigForOverride(params: {
  cfg?: OpenClawConfig;
  modelOverride?: string;
}): ImageModelConfig | null {
  const model = params.modelOverride?.trim();
  if (!model) {
    return null;
  }
  return resolveConfiguredImageModelRefs({
    cfg: params.cfg,
    imageModelConfig: { primary: model },
  });
}

function resolveCompressionModelCandidates(params: {
  cfg?: OpenClawConfig;
  imageModelConfig?: ImageModelConfig | null;
  modelOverride?: string;
  preparedModelRuntime?: PreparedModelRuntimeSnapshot;
  operatorAuthority?: AdmittedRunOperatorAuthority;
}): Array<{ provider: string; model: string }> {
  const overrideConfig = resolveImageModelConfigForOverride({
    cfg: params.cfg,
    modelOverride: params.modelOverride,
  });
  const configuredImageModelConfig = params.imageModelConfig
    ? resolveConfiguredImageModelRefs({
        cfg: params.cfg,
        imageModelConfig: params.imageModelConfig,
      })
    : null;
  const effectiveImageModelConfig = overrideConfig ?? configuredImageModelConfig;
  const effectiveCfg = effectiveImageModelConfig
    ? applyAgentDefaultModelConfig(params.cfg, "imageModel", effectiveImageModelConfig)
    : params.cfg;
  return resolveAllowedImageFallbackCandidates({
    cfg: effectiveCfg,
    modelOverride: params.modelOverride,
    operatorAuthority: params.operatorAuthority,
    manifestPlugins: params.preparedModelRuntime?.metadataSnapshot,
  });
}

export async function prepareImageCompressionPolicy(
  params: {
    abortSignal?: AbortSignal;
    cfg?: OpenClawConfig;
    imageModelConfig?: ImageModelConfig | null;
    modelOverride?: string;
    imageCount: number;
    agentDir?: string;
    workspaceDir?: string;
    preparedModelRuntime?: PreparedModelRuntimeSnapshot;
    operatorAuthority?: AdmittedRunOperatorAuthority;
  },
  deps: ImageModelExecutionDeps,
): Promise<ImageCompressionPolicy> {
  const modelCandidates = resolveCompressionModelCandidates(params);
  const quality = params.cfg?.agents?.defaults?.imageQuality;
  const models = await Promise.all(
    modelCandidates.map((candidate) =>
      resolveImageCompressionModelPolicy({
        abortSignal: params.abortSignal,
        cfg: params.cfg,
        provider: candidate.provider,
        model: candidate.model,
        agentDir: params.agentDir,
        workspaceDir: params.workspaceDir,
        preparedModelRuntime: params.preparedModelRuntime,
        deps: {
          resolveModelAsync: deps.resolveModelAsync,
        },
      }),
    ),
  );
  return {
    imageCount: params.imageCount,
    ...(models.length > 0 ? { models } : {}),
    ...(quality ? { quality } : {}),
  };
}

function matchesImageTimeoutEntry(params: {
  entry: MediaUnderstandingModelConfig;
  provider: string;
  model: string;
  providerRegistry: Map<string, MediaUnderstandingProvider>;
}): boolean {
  const configuredProvider = normalizeMediaProviderId(params.entry.provider ?? "");
  const selectedProvider = normalizeMediaProviderId(params.provider);
  if (!configuredProvider || configuredProvider !== selectedProvider) {
    return false;
  }
  if (
    !matchesMediaEntryCapability({
      entry: params.entry,
      capability: "image",
      providerRegistry: params.providerRegistry,
    })
  ) {
    return false;
  }
  const configuredModel = params.entry.model?.trim();
  if (!configuredModel) {
    return true;
  }
  const providerPrefix = `${selectedProvider}/`;
  const normalizedConfiguredModel = configuredModel.startsWith(providerPrefix)
    ? configuredModel.slice(providerPrefix.length)
    : configuredModel;
  return normalizedConfiguredModel === params.model;
}

function resolveImageToolTimeoutMs(params: {
  cfg: OpenClawConfig;
  provider: string;
  model: string;
  providerRegistry: Map<string, MediaUnderstandingProvider>;
}): number {
  const sharedEntry = params.cfg.tools?.media?.models?.find((entry) =>
    matchesImageTimeoutEntry({
      entry,
      provider: params.provider,
      model: params.model,
      providerRegistry: params.providerRegistry,
    }),
  );
  return resolveTimeoutMs(
    sharedEntry?.timeoutSeconds ?? params.cfg.tools?.media?.image?.timeoutSeconds,
    DEFAULT_TIMEOUT_SECONDS.image,
  );
}

export async function runImagePrompt(
  params: {
    cfg?: OpenClawConfig;
    agentId?: string;
    agentDir: string;
    authStore?: AuthProfileStore;
    imageModelConfig: ImageModelConfig;
    modelOverride?: string;
    prompt: string;
    images: Array<{ buffer: Buffer; mimeType: string }>;
    workspaceDir?: string;
    preparedModelRuntime?: PreparedModelRuntimeSnapshot;
    signal?: AbortSignal;
    operatorAuthority?: AdmittedRunOperatorAuthority;
    assertCurrent?: () => void;
  },
  deps: ImageModelExecutionDeps,
): Promise<{
  text: string;
  provider: string;
  model: string;
  attempts: Array<{ provider: string; model: string; error: string }>;
}> {
  const effectiveCfg = applyAgentDefaultModelConfig(
    params.cfg,
    "imageModel",
    params.imageModelConfig,
  );
  const providerCfg: OpenClawConfig = effectiveCfg ?? {};
  const preparedProviders =
    params.preparedModelRuntime?.mediaCapabilityProviders?.mediaUnderstandingProviders;

  const result = await runWithImageModelFallback({
    cfg: effectiveCfg,
    manifestPlugins: params.preparedModelRuntime?.metadataSnapshot,
    modelOverride: params.modelOverride,
    operatorAuthority: params.operatorAuthority,
    abortSignal: params.signal,
    run: (provider, modelId) =>
      runWithAsyncWorkResources(async (onAcquired) => {
        const execution = bindOperatorModelExecution(params.operatorAuthority, {
          provider,
          model: modelId,
        });
        if (execution) {
          onAcquired({ release: execution.release });
        }
        const signal = execution
          ? params.signal
            ? AbortSignal.any([params.signal, execution.signal])
            : execution.signal
          : params.signal;
        const assertCurrent = () => {
          params.assertCurrent?.();
          signal?.throwIfAborted();
          execution?.assertCurrent();
        };
        assertCurrent();
        // The fallback candidate owns runtime loading; an unrelated media plugin must not
        // block a selected image provider before its request timeout can start.
        const selectedProvider = preparedProviders
          ? findCapabilityProviderById({
              providers: preparedProviders,
              providerId: provider,
              normalizeProviderId: normalizeMediaProviderId,
            })
          : deps.resolveRegisteredMediaUnderstandingProvider({
              providerId: provider,
              cfg: providerCfg,
            });
        const providerRegistry = deps.buildProviderRegistry(
          selectedProvider ? { [provider]: selectedProvider } : undefined,
          providerCfg,
          preparedProviders ?? [],
        );
        const timeoutMs = resolveImageToolTimeoutMs({
          cfg: providerCfg,
          provider,
          model: modelId,
          providerRegistry,
        });
        const imageProvider = deps.getMediaUnderstandingProvider(provider, providerRegistry);
        const request = {
          provider,
          model: modelId,
          prompt: params.prompt,
          maxTokens: resolveImageToolMaxTokens(undefined),
          timeoutMs,
          ...(signal ? { signal } : {}),
          cfg: providerCfg,
          ...(params.agentId ? { agentId: params.agentId } : {}),
          agentDir: params.agentDir,
          authStore: params.authStore,
          ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
          ...(params.preparedModelRuntime
            ? { preparedModelRuntime: params.preparedModelRuntime }
            : {}),
        };
        if (
          params.images.length > 1 &&
          (imageProvider?.describeImages || !imageProvider?.describeImage)
        ) {
          const describeImages = imageProvider?.describeImages ?? deps.describeImagesWithModel;
          // A run cancelled mid-dispatch must not buy another provider call.
          assertCurrent();
          const described = await describeImages({
            images: params.images.map((image, index) => ({
              buffer: image.buffer,
              fileName: `image-${index + 1}`,
              mime: image.mimeType,
            })),
            ...request,
          });
          assertCurrent();
          return { text: described.text, provider, model: described.model ?? modelId };
        }
        const describeImage = imageProvider?.describeImage ?? deps.describeImageWithModel;
        const parts: string[] = [];
        for (const [index, image] of params.images.entries()) {
          // A run cancelled mid-dispatch must not buy another provider call.
          assertCurrent();
          const described = await describeImage({
            buffer: image.buffer,
            fileName: `image-${index + 1}`,
            mime: image.mimeType,
            ...request,
            prompt:
              params.images.length === 1
                ? params.prompt
                : `${params.prompt}\n\nDescribe image ${index + 1} of ${params.images.length}.`,
          });
          assertCurrent();
          if (params.images.length === 1) {
            return { text: described.text, provider, model: described.model ?? modelId };
          }
          parts.push(`Image ${index + 1}:\n${described.text.trim()}`);
        }
        return {
          text: parts.join("\n\n").trim(),
          provider,
          model: modelId,
        };
      }),
  });

  return {
    text: result.result.text,
    provider: result.result.provider,
    model: result.result.model,
    attempts: result.attempts.map((attempt) => ({
      provider: attempt.provider,
      model: attempt.model,
      error: attempt.error,
    })),
  };
}

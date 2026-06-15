/**
 * PDF tool model configuration resolver.
 *
 * Selects explicit PDF, image-model, native PDF, vision, or text-extraction fallback models.
 */
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  providerSupportsNativePdfDocument,
  resolveAutoMediaKeyProviders,
  resolveDefaultMediaModel,
  resolveDocumentMediaModel,
} from "../../media-understanding/defaults.js";
import { configuredModelInputSupportsImage } from "../../media-understanding/known-model-capabilities.js";
import { normalizeMediaProviderId } from "../../media-understanding/provider-id.js";
import { buildMediaUnderstandingRegistry } from "../../media-understanding/provider-registry.js";
import type { AuthProfileStore } from "../auth-profiles/types.js";
import { findNormalizedProviderValue } from "../model-selection.js";
import {
  coerceImageModelConfig,
  type ImageModelConfig,
  imageModelConfigNeedsProviderRegistry,
  resolveConfiguredImageModelRefs,
  resolveProviderVisionModelFromConfig,
} from "./image-tool.helpers.js";
import { hasProviderAuthForTool, resolveDefaultModelRef } from "./model-config.helpers.js";
import { coercePdfModelConfig } from "./pdf-tool.helpers.js";

function formatProviderModelRef(providerId: string, modelId: string): string {
  const slash = modelId.indexOf("/");
  if (slash > 0 && modelId.slice(0, slash).trim() === providerId) {
    return modelId;
  }
  return `${providerId}/${modelId}`;
}

function localModelIdForProvider(providerId: string, modelId: string): string {
  const slash = modelId.indexOf("/");
  if (slash > 0 && modelId.slice(0, slash).trim() === providerId) {
    return modelId.slice(slash + 1).trim();
  }
  return modelId.trim();
}

function configuredProviderHasModelEntries(params: {
  cfg?: OpenClawConfig;
  providerId: string;
}): boolean {
  const providerCfg = findNormalizedProviderValue(
    params.cfg?.models?.providers,
    params.providerId,
  ) as { models?: unknown[] } | undefined;
  return Array.isArray(providerCfg?.models) && providerCfg.models.length > 0;
}

function configuredProviderRuntimeCapabilityRegistry(params: {
  cfg?: OpenClawConfig;
  providerId: string;
  providerRegistry?: ReturnType<typeof buildMediaUnderstandingRegistry>;
}) {
  if (!configuredProviderHasModelEntries(params)) {
    return undefined;
  }
  const providerId = normalizeMediaProviderId(params.providerId);
  const provider = params.providerRegistry?.get(providerId);
  return provider ? new Map([[providerId, provider]]) : undefined;
}

function resolveConfiguredImageRefsForPdf(params: {
  cfg?: OpenClawConfig;
  getProviderRegistry: () => ReturnType<typeof buildMediaUnderstandingRegistry>;
  imageModelConfig: ImageModelConfig;
}): ImageModelConfig {
  return resolveConfiguredImageModelRefs({
    cfg: params.cfg,
    providerRegistry: imageModelConfigNeedsProviderRegistry(params.imageModelConfig)
      ? params.getProviderRegistry()
      : undefined,
    imageModelConfig: params.imageModelConfig,
  });
}

function resolveConfiguredTextModelFromConfig(params: {
  cfg?: OpenClawConfig;
  providerId: string;
}): string | undefined {
  const providers = params.cfg?.models?.providers;
  if (!providers || typeof providers !== "object") {
    return undefined;
  }
  const providerCfg = findNormalizedProviderValue(providers, params.providerId);
  const modelId = providerCfg?.models
    ?.find(
      (model: { id?: string; input?: readonly string[] }) =>
        Boolean(model?.id?.trim()) && Array.isArray(model?.input) && model.input.includes("text"),
    )
    ?.id?.trim();
  return modelId || undefined;
}

function resolveImageCandidateRefs(params: {
  cfg?: OpenClawConfig;
  getProviderRegistry: () => ReturnType<typeof buildMediaUnderstandingRegistry>;
  agentDir: string;
  workspaceDir?: string;
  authStore?: AuthProfileStore;
  filter?: (providerId: string) => boolean;
  includeProviderDefaults?: boolean;
}): string[] {
  // Candidate refs only include providers with usable auth so the tool avoids dead fallbacks.
  return resolveAutoMediaKeyProviders({
    capability: "image",
    cfg: params.cfg,
    workspaceDir: params.workspaceDir,
  })
    .filter((providerId) => !params.filter || params.filter(providerId))
    .filter((providerId) =>
      hasProviderAuthForTool({
        provider: providerId,
        cfg: params.cfg,
        workspaceDir: params.workspaceDir,
        agentDir: params.agentDir,
        authStore: params.authStore,
      }),
    )
    .map((providerId) => {
      const documentImageModel = resolveDocumentMediaModel({
        cfg: params.cfg,
        workspaceDir: params.workspaceDir,
        providerId,
        document: "pdf",
        mode: "image",
      });
      if (documentImageModel === false) {
        return null;
      }
      const providerHasConfiguredModels = configuredProviderHasModelEntries({
        cfg: params.cfg,
        providerId,
      });
      const providerVision = resolveProviderVisionModelFromConfig({
        cfg: params.cfg,
        providerRegistry: configuredProviderRuntimeCapabilityRegistry({
          cfg: params.cfg,
          providerId,
          providerRegistry: params.getProviderRegistry(),
        }),
        provider: providerId,
      });
      const providerVisionModel = providerVision
        ? localModelIdForProvider(providerId, providerVision)
        : undefined;
      const providerDefaultModel =
        params.includeProviderDefaults && !providerHasConfiguredModels
          ? resolveDefaultMediaModel({
              cfg: params.cfg,
              workspaceDir: params.workspaceDir,
              providerId,
              capability: "image",
            })
          : undefined;
      const modelId = documentImageModel ?? providerVisionModel ?? providerDefaultModel;
      return modelId ? formatProviderModelRef(providerId, modelId) : null;
    })
    .filter((value): value is string => Boolean(value));
}

function resolveTextExtractionCandidateRefs(params: {
  cfg?: OpenClawConfig;
  primary: { provider: string; model: string };
  agentDir: string;
  workspaceDir?: string;
  authStore?: AuthProfileStore;
}): string[] {
  const candidates: string[] = [];
  const addCandidate = (providerId: string, modelId: string) => {
    const provider = providerId.trim();
    const model = modelId.trim();
    if (!provider || !model) {
      return;
    }
    const ref = formatProviderModelRef(provider, model);
    if (!candidates.includes(ref)) {
      candidates.push(ref);
    }
  };

  const providerIds = [
    params.primary.provider,
    ...resolveAutoMediaKeyProviders({
      capability: "image",
      cfg: params.cfg,
      workspaceDir: params.workspaceDir,
    }),
  ];
  for (const providerId of providerIds) {
    if (
      !providerId ||
      !hasProviderAuthForTool({
        provider: providerId,
        cfg: params.cfg,
        workspaceDir: params.workspaceDir,
        agentDir: params.agentDir,
        authStore: params.authStore,
      })
    ) {
      continue;
    }
    const documentTextModel = resolveDocumentMediaModel({
      cfg: params.cfg,
      workspaceDir: params.workspaceDir,
      providerId,
      document: "pdf",
      mode: "textExtraction",
    });
    if (!documentTextModel) {
      continue;
    }
    const documentImageModel = resolveDocumentMediaModel({
      cfg: params.cfg,
      workspaceDir: params.workspaceDir,
      providerId,
      document: "pdf",
      mode: "image",
    });
    const preferredTextModel =
      providerId === params.primary.provider
        ? params.primary.model
        : resolveConfiguredTextModelFromConfig({ cfg: params.cfg, providerId });
    const providerDefaultImageModel = resolveDefaultMediaModel({
      cfg: params.cfg,
      workspaceDir: params.workspaceDir,
      providerId,
      capability: "image",
      includeConfiguredImageModels: false,
    });
    const preferredLocalModel = preferredTextModel
      ? localModelIdForProvider(providerId, preferredTextModel)
      : "";
    const preferredIsImageModel =
      Boolean(preferredLocalModel) &&
      ((typeof documentImageModel === "string" &&
        localModelIdForProvider(providerId, documentImageModel) === preferredLocalModel) ||
        providerDefaultImageModel === preferredLocalModel);
    const model =
      preferredTextModel && !preferredIsImageModel ? preferredTextModel : documentTextModel;
    addCandidate(providerId, model);
  }

  return candidates;
}

export function resolvePdfModelConfigForTool(params: {
  cfg?: OpenClawConfig;
  agentDir: string;
  workspaceDir?: string;
  authStore?: AuthProfileStore;
}): ImageModelConfig | null {
  let providerRegistry: ReturnType<typeof buildMediaUnderstandingRegistry> | undefined;
  const getProviderRegistry = () => {
    providerRegistry ??= buildMediaUnderstandingRegistry(undefined, params.cfg);
    return providerRegistry;
  };
  const explicitPdf = coercePdfModelConfig(params.cfg);
  if (explicitPdf.primary?.trim() || (explicitPdf.fallbacks?.length ?? 0) > 0) {
    // PDF-specific config wins over generic image model config.
    return resolveConfiguredImageRefsForPdf({
      cfg: params.cfg,
      getProviderRegistry,
      imageModelConfig: explicitPdf,
    });
  }

  const explicitImage = coerceImageModelConfig(params.cfg);
  if (explicitImage.primary?.trim() || (explicitImage.fallbacks?.length ?? 0) > 0) {
    return resolveConfiguredImageRefsForPdf({
      cfg: params.cfg,
      getProviderRegistry,
      imageModelConfig: explicitImage,
    });
  }

  const primary = resolveDefaultModelRef(params.cfg);
  const googleOk = hasProviderAuthForTool({
    provider: "google",
    cfg: params.cfg,
    workspaceDir: params.workspaceDir,
    agentDir: params.agentDir,
    authStore: params.authStore,
  });

  const fallbacks: string[] = [];
  const addFallback = (ref: string) => {
    const trimmed = ref.trim();
    if (trimmed && !fallbacks.includes(trimmed)) {
      fallbacks.push(trimmed);
    }
  };

  let preferred: string | null = null;

  const providerOk = hasProviderAuthForTool({
    provider: primary.provider,
    cfg: params.cfg,
    workspaceDir: params.workspaceDir,
    agentDir: params.agentDir,
    authStore: params.authStore,
  });
  const primaryProviderHasConfiguredModels = configuredProviderHasModelEntries({
    cfg: params.cfg,
    providerId: primary.provider,
  });
  const primaryProviderRegistry = configuredProviderRuntimeCapabilityRegistry({
    cfg: params.cfg,
    providerId: primary.provider,
    providerRegistry: getProviderRegistry(),
  });
  const providerVision = providerOk
    ? resolveProviderVisionModelFromConfig({
        cfg: params.cfg,
        providerRegistry: primaryProviderRegistry,
        provider: primary.provider,
      })
    : null;
  const providerDefault = providerOk
    ? (providerVision ? localModelIdForProvider(primary.provider, providerVision) : "") ||
      (primaryProviderHasConfiguredModels
        ? undefined
        : resolveDefaultMediaModel({
            cfg: params.cfg,
            workspaceDir: params.workspaceDir,
            providerId: primary.provider,
            capability: "image",
          }))
    : undefined;
  const primarySupportsNativePdf = providerSupportsNativePdfDocument({
    cfg: params.cfg,
    workspaceDir: params.workspaceDir,
    providerId: primary.provider,
  });
  const nativePdfCandidates = resolveImageCandidateRefs({
    cfg: params.cfg,
    getProviderRegistry,
    agentDir: params.agentDir,
    workspaceDir: params.workspaceDir,
    authStore: params.authStore,
    includeProviderDefaults: true,
    filter: (providerId) =>
      providerSupportsNativePdfDocument({
        cfg: params.cfg,
        workspaceDir: params.workspaceDir,
        providerId,
      }),
  });
  const genericImageCandidates = resolveImageCandidateRefs({
    cfg: params.cfg,
    getProviderRegistry,
    agentDir: params.agentDir,
    workspaceDir: params.workspaceDir,
    authStore: params.authStore,
    includeProviderDefaults: true,
  });
  const textExtractionCandidates = resolveTextExtractionCandidateRefs({
    cfg: params.cfg,
    primary,
    agentDir: params.agentDir,
    workspaceDir: params.workspaceDir,
    authStore: params.authStore,
  });
  const preferPrimaryTextExtraction =
    providerOk && textExtractionCandidates.some((ref) => ref.startsWith(`${primary.provider}/`));

  if (params.cfg?.models?.providers && typeof params.cfg.models.providers === "object") {
    // Configured provider vision models are added even when not present in static media defaults.
    for (const [providerKey, providerCfg] of Object.entries(params.cfg.models.providers)) {
      const providerId = providerKey.trim();
      const documentImageModel = providerId
        ? resolveDocumentMediaModel({
            cfg: params.cfg,
            workspaceDir: params.workspaceDir,
            providerId,
            document: "pdf",
            mode: "image",
          })
        : undefined;
      if (
        !providerId ||
        documentImageModel === false ||
        !hasProviderAuthForTool({
          provider: providerId,
          cfg: params.cfg,
          workspaceDir: params.workspaceDir,
          agentDir: params.agentDir,
          authStore: params.authStore,
        })
      ) {
        continue;
      }
      const providerMetadata = configuredProviderRuntimeCapabilityRegistry({
        cfg: params.cfg,
        providerId,
        providerRegistry: getProviderRegistry(),
      })?.get(normalizeMediaProviderId(providerId));
      const models = providerCfg?.models ?? [];
      const modelId = models
        .find((model) => {
          const candidateModelId = model?.id?.trim();
          return Boolean(
            candidateModelId &&
            configuredModelInputSupportsImage({
              modelId: candidateModelId,
              input: model?.input,
              provider: providerMetadata,
            }),
          );
        })
        ?.id?.trim();
      if (!modelId) {
        continue;
      }
      const ref = `${providerId}/${modelId}`;
      if (!genericImageCandidates.includes(ref)) {
        genericImageCandidates.push(ref);
      }
    }
  }

  const fallbackCandidates = preferPrimaryTextExtraction
    ? [...nativePdfCandidates, ...textExtractionCandidates, ...genericImageCandidates]
    : [...nativePdfCandidates, ...genericImageCandidates, ...textExtractionCandidates];

  if (primary.provider === "google" && googleOk && providerVision && primarySupportsNativePdf) {
    // Google native PDF handling is preferred when auth and a configured vision model are present.
    preferred = providerVision;
  } else if (providerOk && primarySupportsNativePdf && (providerVision || providerDefault)) {
    preferred = providerVision ?? `${primary.provider}/${providerDefault}`;
  } else {
    preferred = fallbackCandidates[0] ?? null;
  }

  if (preferred?.trim()) {
    for (const candidate of fallbackCandidates) {
      if (candidate !== preferred) {
        addFallback(candidate);
      }
    }
    const pruned = fallbacks.filter((ref) => ref !== preferred);
    return { primary: preferred, ...(pruned.length > 0 ? { fallbacks: pruned } : {}) };
  }

  return null;
}

import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  providerSupportsNativePdfDocument,
  resolveAutoMediaKeyProviders,
  resolveDefaultMediaModel,
  resolveDocumentMediaModel,
} from "../../media-understanding/defaults.js";
import type { AuthProfileStore } from "../auth-profiles/types.js";
import { findNormalizedProviderValue } from "../model-selection.js";
import {
  coerceImageModelConfig,
  type ImageModelConfig,
  resolveConfiguredImageModelRefs,
  resolveProviderVisionModelFromConfig,
} from "./image-tool.helpers.js";
import { hasProviderAuthForTool, resolveDefaultModelRef } from "./model-config.helpers.js";
import { coercePdfModelConfig } from "./pdf-tool.helpers.js";

export type PdfToolActiveModel = {
  provider: string;
  model: string;
  supportsImages: boolean;
};

type PdfModelConfigContext = {
  cfg?: OpenClawConfig;
  agentDir: string;
  workspaceDir?: string;
  authStore?: AuthProfileStore;
};

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

function resolveConfiguredTextModelFromConfig(params: {
  cfg?: OpenClawConfig;
  providerId: string;
}): string | undefined {
  const providers = params.cfg?.models?.providers;
  if (!providers) {
    return undefined;
  }
  const providerCfg = findNormalizedProviderValue(providers, params.providerId);
  const modelId = providerCfg?.models
    ?.find((model) => Boolean(model?.id?.trim()) && model.input?.includes("text"))
    ?.id?.trim();
  return modelId || undefined;
}

function resolveImageCandidateRefs(
  params: PdfModelConfigContext & { filter?: (providerId: string) => boolean },
): string[] {
  // Candidate refs only include providers with usable auth so the tool avoids dead fallbacks.
  return resolveAutoMediaKeyProviders({
    capability: "image",
    cfg: params.cfg,
    workspaceDir: params.workspaceDir,
  })
    .filter((providerId) => !params.filter || params.filter(providerId))
    .filter((providerId) => hasProviderAuthForTool({ ...params, provider: providerId }))
    .map((providerId) => {
      const documentImageModel = resolveDocumentMediaModel({
        cfg: params.cfg,
        workspaceDir: params.workspaceDir,
        providerId,
        mode: "image",
      });
      if (documentImageModel === false) {
        return null;
      }
      const modelId =
        documentImageModel ??
        resolveProviderVisionModelFromConfig({
          cfg: params.cfg,
          provider: providerId,
        })?.split("/")[1] ??
        resolveDefaultMediaModel({
          cfg: params.cfg,
          workspaceDir: params.workspaceDir,
          providerId,
          capability: "image",
        });
      return modelId ? formatProviderModelRef(providerId, modelId) : null;
    })
    .filter((value): value is string => Boolean(value));
}

export function resolvePdfModelConfigForTool(
  params: PdfModelConfigContext & { activeModel?: PdfToolActiveModel },
): ImageModelConfig | null {
  // PDF-specific config wins over generic image model config.
  for (const coerce of [coercePdfModelConfig, coerceImageModelConfig]) {
    const explicit = coerce(params.cfg);
    if (explicit.primary?.trim() || (explicit.fallbacks?.length ?? 0) > 0) {
      return resolveConfiguredImageModelRefs({ cfg: params.cfg, imageModelConfig: explicit });
    }
  }

  const primary = resolveDefaultModelRef(params.cfg);

  const activeProvider = params.activeModel?.provider.trim();
  const activeModel = params.activeModel?.model.trim();
  const activeFallback =
    params.activeModel?.supportsImages === true &&
    activeProvider &&
    activeModel &&
    resolveDocumentMediaModel({
      cfg: params.cfg,
      workspaceDir: params.workspaceDir,
      providerId: activeProvider,
      mode: "image",
    }) !== false &&
    hasProviderAuthForTool({ ...params, provider: activeProvider })
      ? formatProviderModelRef(activeProvider, activeModel)
      : null;
  const providerOk = hasProviderAuthForTool({ ...params, provider: primary.provider });
  const providerVision = resolveProviderVisionModelFromConfig({
    cfg: params.cfg,
    provider: primary.provider,
  });
  const providerDefault =
    providerVision?.split("/")[1] ??
    resolveDefaultMediaModel({
      cfg: params.cfg,
      workspaceDir: params.workspaceDir,
      providerId: primary.provider,
      capability: "image",
    });
  const primarySupportsNativePdf = providerSupportsNativePdfDocument({
    cfg: params.cfg,
    workspaceDir: params.workspaceDir,
    providerId: primary.provider,
  });
  const nativePdfCandidates = resolveImageCandidateRefs({
    ...params,
    filter: (providerId) =>
      providerSupportsNativePdfDocument({
        cfg: params.cfg,
        workspaceDir: params.workspaceDir,
        providerId,
      }),
  });
  const genericImageCandidates = resolveImageCandidateRefs(params);
  const textExtractionParams = { ...params, primary };
  const textExtractionCandidates: string[] = [];
  const providerIds = [
    textExtractionParams.primary.provider,
    ...resolveAutoMediaKeyProviders({
      capability: "image",
      cfg: textExtractionParams.cfg,
      workspaceDir: textExtractionParams.workspaceDir,
    }),
  ];
  for (const providerId of providerIds) {
    if (!providerId || !hasProviderAuthForTool({ ...textExtractionParams, provider: providerId })) {
      continue;
    }
    const documentTextModel = resolveDocumentMediaModel({
      cfg: textExtractionParams.cfg,
      workspaceDir: textExtractionParams.workspaceDir,
      providerId,
      mode: "textExtraction",
    });
    if (!documentTextModel) {
      continue;
    }
    const documentImageModel = resolveDocumentMediaModel({
      cfg: textExtractionParams.cfg,
      workspaceDir: textExtractionParams.workspaceDir,
      providerId,
      mode: "image",
    });
    const preferredTextModel =
      providerId === textExtractionParams.primary.provider
        ? textExtractionParams.primary.model
        : resolveConfiguredTextModelFromConfig({ cfg: textExtractionParams.cfg, providerId });
    const providerDefaultImageModel = resolveDefaultMediaModel({
      cfg: textExtractionParams.cfg,
      workspaceDir: textExtractionParams.workspaceDir,
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
    const selectedModel =
      preferredTextModel && !preferredIsImageModel ? preferredTextModel : documentTextModel;
    const provider = providerId.trim();
    const model = selectedModel.trim();
    if (!provider || !model) {
      continue;
    }
    const ref = formatProviderModelRef(provider, model);
    if (!textExtractionCandidates.includes(ref)) {
      textExtractionCandidates.push(ref);
    }
  }
  const preferPrimaryTextExtraction =
    providerOk && textExtractionCandidates.some((ref) => ref.startsWith(`${primary.provider}/`));

  if (params.cfg?.models?.providers) {
    // Configured provider vision models are added even when not present in static media defaults.
    for (const [providerKey, providerCfg] of Object.entries(params.cfg.models.providers)) {
      const providerId = providerKey.trim();
      const documentImageModel = providerId
        ? resolveDocumentMediaModel({
            cfg: params.cfg,
            workspaceDir: params.workspaceDir,
            providerId,
            mode: "image",
          })
        : undefined;
      if (
        !providerId ||
        documentImageModel === false ||
        !hasProviderAuthForTool({ ...params, provider: providerId })
      ) {
        continue;
      }
      const models = providerCfg?.models ?? [];
      const modelId = models
        .find((model) => Boolean(model?.id?.trim()) && model.input?.includes("image"))
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

  let preferred =
    providerOk && primarySupportsNativePdf && (providerVision || providerDefault)
      ? (providerVision ?? `${primary.provider}/${providerDefault}`)
      : (fallbackCandidates[0] ?? null);

  // Preserve every existing native/auto candidate decision. The admitted session model
  // only fills the previous no-model gap when it can inspect images and has usable auth.
  preferred ??= activeFallback;

  if (preferred?.trim()) {
    const fallbacks = [...new Set(fallbackCandidates.map((ref) => ref.trim()))].filter(
      (ref) => ref && ref !== preferred,
    );
    return { primary: preferred, ...(fallbacks.length > 0 ? { fallbacks } : {}) };
  }

  return null;
}

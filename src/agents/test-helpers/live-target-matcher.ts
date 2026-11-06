import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { normalizeGooglePreviewModelId } from "@openclaw/model-catalog-core/provider-model-id-normalize";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
} from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { liveProvidersShareOwningPlugin } from "../live-provider-owner.js";

type TargetFilters = {
  providerFilter: Set<string> | null;
  modelFilter: Set<string> | null;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
};

const GOOGLE_LIVE_TARGET_PROVIDERS = new Set(["google", "google-gemini-cli", "google-vertex"]);

function normalizeCsvSet(values: Set<string> | null): Set<string> | null {
  const normalized = new Set([...(values ?? [])].map((value) => value.trim()).filter(Boolean));
  return normalized.size > 0 ? normalized : null;
}

function parseModelTarget(raw: string) {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  const slash = trimmed.indexOf("/");
  const provider = slash === -1 ? undefined : normalizeProviderId(trimmed.slice(0, slash));
  const rawModelId = trimmed.slice(slash + 1).trim();
  const modelId = normalizeLowercaseStringOrEmpty(
    provider && GOOGLE_LIVE_TARGET_PROVIDERS.has(provider)
      ? normalizeGooglePreviewModelId(rawModelId)
      : rawModelId,
  );
  if ((slash !== -1 && !provider) || !modelId) {
    return null;
  }
  return { raw: trimmed, provider, modelId };
}

/** Creates provider/model predicates for live test target filters. */
export function createLiveTargetMatcher(params: TargetFilters) {
  const providerFilter = normalizeCsvSet(params.providerFilter);
  const modelTargets = [...(normalizeCsvSet(params.modelFilter) ?? [])]
    .map(parseModelTarget)
    .filter((value) => value !== null);
  const ownerCache = new Map<string, readonly string[]>();
  const sameProvider = (left: string, right: string) =>
    left === right ||
    liveProvidersShareOwningPlugin(left, right, {
      config: params.config,
      workspaceDir: params.workspaceDir,
      env: params.env,
      ownerCache,
    });

  return {
    matchesProvider(provider: string): boolean {
      if (!providerFilter) {
        return true;
      }
      const normalizedProvider = normalizeProviderId(provider);
      return [...providerFilter].some((requested) =>
        sameProvider(normalizeProviderId(requested), normalizedProvider),
      );
    },
    matchesModel(provider: string, modelId: string): boolean {
      if (modelTargets.length === 0) {
        return true;
      }
      const normalizedProvider = normalizeProviderId(provider);
      const normalizedModelId = normalizeOptionalLowercaseString(modelId);
      if (!normalizedModelId) {
        return false;
      }
      const directRef = `${normalizedProvider}/${normalizedModelId}`;
      return modelTargets.some(
        (target) =>
          normalizeOptionalLowercaseString(target.raw) === directRef ||
          (target.modelId === normalizedModelId &&
            (!target.provider || sameProvider(target.provider, normalizedProvider))),
      );
    },
  };
}

/** Reports selectors with no candidate in their admitted provider scope. */
export function findUnmatchedLiveModelSelectors(
  params: TargetFilters & {
    modelFilter: Set<string>;
    models: readonly { provider: string; id: string }[];
  },
): string[] {
  const targetMatcher = createLiveTargetMatcher(params);
  return [...params.modelFilter].filter((raw) => {
    const target = parseModelTarget(raw);
    if (!target) {
      return true;
    }
    if (target.provider && !targetMatcher.matchesProvider(target.provider)) {
      return false;
    }
    const selector = createLiveTargetMatcher({ ...params, modelFilter: new Set([raw]) });
    return !params.models.some(
      (model) =>
        selector.matchesProvider(model.provider) && selector.matchesModel(model.provider, model.id),
    );
  });
}

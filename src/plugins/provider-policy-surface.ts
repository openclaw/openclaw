/** Lightweight direct loader for bundled provider policy public artifacts. */
import type { ModelApi, ModelProviderConfig } from "../config/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveBundledPluginsDir } from "./bundled-dir.js";
import type {
  ProviderApplyConfigDefaultsContext,
  ProviderNormalizeConfigContext,
  ProviderResolveConfigApiKeyContext,
} from "./provider-config-context.types.js";
import type {
  ProviderDefaultThinkingPolicyContext,
  ProviderThinkingProfile,
} from "./provider-thinking.types.js";
import { loadBundledPluginPublicArtifactModuleSync } from "./public-surface-loader.js";

const PROVIDER_POLICY_ARTIFACT_CANDIDATES = ["provider-policy-api.js"] as const;
const providerPolicySurfaceByPluginId = new Map<string, BundledProviderPolicySurface | null>();

export type ProviderModelRouteSource = {
  api?: ModelApi | null;
  baseUrl?: unknown;
};

/** A concrete provider route. Order expresses provider default, never credential precedence. */
export type ProviderModelRouteAuthRequirement = "api-key" | "subscription";

export type ProviderModelRouteCandidate = {
  api: ModelApi;
  baseUrl: string;
  authRequirement: ProviderModelRouteAuthRequirement;
};

export type ProviderModelRouteResolution =
  | {
      kind: "routes";
      routes: readonly [ProviderModelRouteCandidate, ...ProviderModelRouteCandidate[]];
      /** Advisory only; authored agentRuntime policy remains authoritative. */
      defaultRuntimeId?: string;
    }
  | {
      kind: "incompatible";
      code: string;
      message: string;
    };

export type ProviderResolveModelRoutesContext = {
  provider: string;
  modelId?: string;
  configuredModel?: ProviderModelRouteSource;
  configuredProvider?: ProviderModelRouteSource;
  environment?: { baseUrl?: unknown };
  observed?: ProviderModelRouteSource;
};

/** Provider policy hooks loaded from bundled plugin public artifacts. */
export type BundledProviderPolicySurface = {
  normalizeConfig?: (ctx: ProviderNormalizeConfigContext) => ModelProviderConfig | null | undefined;
  applyConfigDefaults?: (
    ctx: ProviderApplyConfigDefaultsContext,
  ) => OpenClawConfig | null | undefined;
  resolveConfigApiKey?: (ctx: ProviderResolveConfigApiKeyContext) => string | null | undefined;
  resolveThinkingProfile?: (
    ctx: ProviderDefaultThinkingPolicyContext,
  ) => ProviderThinkingProfile | null | undefined;
  resolveModelRoutes?: (
    ctx: ProviderResolveModelRoutesContext,
  ) => ProviderModelRouteResolution | null | undefined;
};

function hasProviderPolicyHook(
  mod: Record<string, unknown>,
): mod is Record<string, unknown> & BundledProviderPolicySurface {
  return (
    typeof mod.normalizeConfig === "function" ||
    typeof mod.applyConfigDefaults === "function" ||
    typeof mod.resolveConfigApiKey === "function" ||
    typeof mod.resolveThinkingProfile === "function" ||
    typeof mod.resolveModelRoutes === "function"
  );
}

/** Loads policy hooks directly by canonical bundled plugin id. */
export function resolveDirectBundledProviderPolicySurface(
  pluginId: string,
): BundledProviderPolicySurface | null {
  const cacheKey = `${resolveBundledPluginsDir() ?? ""}\0${pluginId}`;
  const cached = providerPolicySurfaceByPluginId.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }
  for (const artifactBasename of PROVIDER_POLICY_ARTIFACT_CANDIDATES) {
    try {
      const mod = loadBundledPluginPublicArtifactModuleSync<Record<string, unknown>>({
        dirName: pluginId,
        artifactBasename,
      });
      if (hasProviderPolicyHook(mod)) {
        providerPolicySurfaceByPluginId.set(cacheKey, mod);
        return mod;
      }
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.startsWith("Unable to resolve bundled plugin public surface ")
      ) {
        continue;
      }
      throw error;
    }
  }
  providerPolicySurfaceByPluginId.set(cacheKey, null);
  return null;
}

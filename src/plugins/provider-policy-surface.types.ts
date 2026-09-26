/** Lightweight contracts shared by provider policy resolution and its metadata cache. */
import type { ModelProviderConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type {
  ProviderFastModePolicyContext,
  ProviderModelAuthPolicy,
  ProviderModelAuthPolicyContext,
  ProviderModelRouteResolution,
  ProviderNativeWebSearchPolicyContext,
  ProviderNormalizeModelCatalogIdContext,
  ProviderResponseModelEquivalenceContext,
  ProviderResolveModelRoutesContext,
  ProviderToolSearchPolicyContext,
} from "../plugin-sdk/provider-model-types.js";
import type {
  ProviderApplyConfigDefaultsContext,
  ProviderNormalizeConfigContext,
  ProviderResolveConfigApiKeyContext,
} from "./provider-config-context.types.js";
import type { ProviderRuntimeModel } from "./provider-runtime-model.types.js";
import type {
  ProviderDefaultThinkingPolicyContext,
  ProviderThinkingProfile,
} from "./provider-thinking.types.js";

type ProviderProjectConfiguredModelRowContext = {
  config?: OpenClawConfig;
  agentDir?: string;
  workspaceDir?: string;
  provider: string;
  modelId: string;
  model: ProviderRuntimeModel;
};

type ProviderProjectRealtimeVoicePublicConfigContext = {
  providerConfig: Record<string, unknown>;
  config: Record<string, unknown>;
};

export type RealtimeVoicePublicClientHints = {
  modelSource?: "gateway";
  gatewayRelaySupported?: boolean;
};

export type RealtimeVoicePublicProjection = {
  config: Record<string, unknown>;
  clientHints?: RealtimeVoicePublicClientHints;
};

type EmbeddingProviderSetupInspection = {
  provider: string;
  reason: string;
  requirement?: string;
  fixHint?: string;
};

export type InspectEmbeddingProviderSetup = (params: {
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  agentId: string;
  provider: string;
}) => EmbeddingProviderSetupInspection | null | Promise<EmbeddingProviderSetupInspection | null>;

/** Provider policy hooks supported by bundled and trusted official plugins. */
export type ProviderPolicySurface = {
  resolveModelAuthPolicy?: (
    ctx: ProviderModelAuthPolicyContext,
  ) => ProviderModelAuthPolicy | undefined;
  resolveFastModeSupport?: (ctx: ProviderFastModePolicyContext) => boolean | undefined;
  deprecatedProfileIds?: readonly string[];
  normalizeConfig?: (ctx: ProviderNormalizeConfigContext) => ModelProviderConfig | null | undefined;
  applyConfigDefaults?: (
    ctx: ProviderApplyConfigDefaultsContext,
  ) => OpenClawConfig | null | undefined;
  resolveConfigApiKey?: (ctx: ProviderResolveConfigApiKeyContext) => string | null | undefined;
  resolveThinkingProfile?: (
    ctx: ProviderDefaultThinkingPolicyContext,
  ) => ProviderThinkingProfile | null | undefined;
  /** Whether the provider supplies hosted web search instead of managed search. */
  resolveNativeWebSearch?: (ctx: ProviderNativeWebSearchPolicyContext) => boolean;
  /** Prefer compact tool discovery, or veto a managed-service default for a hosted route. */
  resolveToolSearchMode?: (ctx: ProviderToolSearchPolicyContext) => "tools" | false | undefined;
  resolveModelRoutes?: (
    ctx: ProviderResolveModelRoutesContext,
  ) => ProviderModelRouteResolution | null | undefined;
  normalizeModelCatalogId?: (
    ctx: ProviderNormalizeModelCatalogIdContext,
  ) => string | null | undefined;
  isResponseModelEquivalent?: (
    ctx: ProviderResponseModelEquivalenceContext,
  ) => boolean | null | undefined;
  inspectEmbeddingProviderSetup?: InspectEmbeddingProviderSetup;
};

/** Provider policy hooks loaded only from bundled plugin public artifacts. */
export type BundledProviderPolicySurface = ProviderPolicySurface & {
  projectConfiguredModelRow?: (
    ctx: ProviderProjectConfiguredModelRowContext,
  ) => ProviderRuntimeModel | null | undefined;
  projectRealtimeVoicePublicProjection?: (
    ctx: ProviderProjectRealtimeVoicePublicConfigContext,
  ) => RealtimeVoicePublicProjection | null | undefined;
};

import {
  resolveAgentModelFallbackValues,
  resolveAgentModelPrimaryValue,
  resolveAgentModelTimeoutMsValue,
} from "../../config/model-input.js";
import type { AgentToolModelConfig } from "../../config/types.agents-shared.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  externalCliDiscoveryForProviderAuth,
  ensureAuthProfileStore,
  ensureAuthProfileStoreWithoutExternalProfiles,
  hasAnyAuthProfileStoreSource,
  listProfilesForProvider,
  resolveAuthProfileOrder,
} from "../auth-profiles.js";
import { evaluateStoredCredentialEligibility } from "../auth-profiles/credential-state.js";
import { resolveExternalCliAuthProfiles } from "../auth-profiles/external-cli-sync.js";
import { overlayRuntimeExternalOAuthProfiles } from "../auth-profiles/oauth-shared.js";
import type { AuthProfileCredential, AuthProfileStore } from "../auth-profiles/types.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../defaults.js";
import { isAuthModeAllowedForModel } from "../model-auth-policy.js";
import { profileTypeToAuthMode } from "../model-auth-provider-config.js";
import {
  hasRuntimeAvailableProviderAuth,
  resolveProviderEntryApiKeyProfileReference,
  resolveEnvApiKey,
  type RuntimeProviderAuthLookup,
} from "../model-auth.js";
import { resolveConfiguredModelRef } from "../model-selection.js";

export type ToolModelConfig = Exclude<AgentToolModelConfig, string>;

const OPENAI_PROVIDER_ID = "openai";
const CODEX_MEDIA_PROVIDER_ID = "codex";
const OPENAI_RESPONSES_MODEL_API = "openai-responses";

type OpenAiImageMediaCandidateDecision =
  | { kind: "keep"; ref: string }
  | { kind: "substitute"; ref: string; provider: string }
  | { kind: "drop" };

export function applyAgentDefaultModelConfig(
  cfg: OpenClawConfig | undefined,
  key: "imageModel" | "image" | "video" | "music",
  modelConfig: ToolModelConfig,
): OpenClawConfig | undefined {
  if (!cfg) {
    return undefined;
  }
  return {
    ...cfg,
    agents: {
      ...cfg.agents,
      defaults: {
        ...cfg.agents?.defaults,
        ...(key === "imageModel"
          ? { imageModel: modelConfig }
          : { mediaModels: { ...cfg.agents?.defaults?.mediaModels, [key]: modelConfig } }),
      },
    },
  };
}

export function hasToolModelConfig(model: ToolModelConfig | undefined): boolean {
  return Boolean(
    model?.primary?.trim() || (model?.fallbacks ?? []).some((entry) => entry.trim().length > 0),
  );
}

export function resolveDefaultModelRef(cfg?: OpenClawConfig): { provider: string; model: string } {
  if (cfg) {
    const resolved = resolveConfiguredModelRef({
      cfg,
      defaultProvider: DEFAULT_PROVIDER,
      defaultModel: DEFAULT_MODEL,
    });
    return { provider: resolved.provider, model: resolved.model };
  }
  return { provider: DEFAULT_PROVIDER, model: DEFAULT_MODEL };
}

export function hasAuthForProvider(params: {
  provider: string;
  cfg?: OpenClawConfig;
  workspaceDir?: string;
  agentDir?: string;
  authStore?: AuthProfileStore;
  authProfileStoreSource?: boolean;
  runtimeLookup?: RuntimeProviderAuthLookup;
  capability?: string;
}): boolean {
  // Env-key resolution is config/workspace aware: plugin-provider env candidates
  // come from the metadata snapshot resolved for this config. Non-bundled or
  // config-scoped provider plugins are invisible without it, so a config-blind
  // lookup would wrongly report "no auth" for env-key providers.
  if (
    !params.runtimeLookup &&
    resolveEnvApiKey(params.provider, undefined, {
      config: params.cfg,
      workspaceDir: params.workspaceDir,
    })?.apiKey &&
    (!params.capability ||
      isAuthModeAllowedForModel({
        provider: params.provider,
        capability: params.capability,
        mode: "api-key",
      }))
  ) {
    return true;
  }
  return hasAuthProfileForProvider({
    provider: params.provider,
    agentDir: params.agentDir,
    authStore: params.authStore,
    authProfileStoreSource: params.authProfileStoreSource,
    includeExternalCli: true,
    capability: params.capability,
  });
}

export function hasAuthProfileForProvider(params: {
  provider: string;
  agentDir?: string;
  authStore?: AuthProfileStore;
  authProfileStoreSource?: boolean;
  includeExternalCli?: boolean;
  type?: AuthProfileCredential["type"];
  capability?: string;
}): boolean {
  let store = params.authStore;
  if (!store) {
    const agentDir = params.agentDir?.trim();
    // Runtime callers carry the source fact; CLI setup retains synchronous discovery.
    if (!agentDir || !(params.authProfileStoreSource ?? hasAnyAuthProfileStoreSource(agentDir))) {
      return false;
    }
    store = loadAuthStoreForProvider({ ...params, agentDir });
    if (!store) {
      return false;
    }
  }
  const profileIds = listProfilesForProvider(store, params.provider);
  return profileIds.some((profileId) => {
    const credential = store.profiles[profileId];
    return (
      credential &&
      (!params.type || credential.type === params.type) &&
      (!params.capability ||
        isAuthModeAllowedForModel({
          provider: params.provider,
          capability: params.capability,
          mode: profileTypeToAuthMode(credential.type),
          authFlow: credential.type === "oauth" ? credential.authFlow : undefined,
        }))
    );
  });
}

export function hasProviderAuthForTool(params: Parameters<typeof hasAuthForProvider>[0]): boolean {
  const store = loadAuthStoreForProvider(params);
  if (params.capability && store) {
    const binding = resolveProviderEntryApiKeyProfileReference({ ...params, store });
    // An explicitly selected credential owns the operation; discovery must not
    // advertise another account when execution would reject this binding.
    if (binding.kind === "profile-incompatible") {
      return false;
    }
    if (
      binding.kind === "profile" &&
      !isAuthModeAllowedForModel({
        provider: params.provider,
        capability: params.capability,
        mode: binding.mode,
        authFlow: binding.credential.type === "oauth" ? binding.credential.authFlow : undefined,
      })
    ) {
      return false;
    }
  }
  if (
    hasRuntimeAvailableProviderAuth({
      provider: params.provider,
      cfg: params.cfg,
      workspaceDir: params.workspaceDir,
      allowPluginSyntheticAuth: false,
      runtimeLookup: params.runtimeLookup,
      capability: params.capability,
      // Without the store, inline provider keys in billing cooldown would
      // still be advertised as available to model-backed tools.
      store,
    })
  ) {
    return true;
  }
  return hasAuthForProvider(params);
}

function loadAuthStoreForProvider(params: {
  provider: string;
  cfg?: OpenClawConfig;
  agentDir?: string;
  authStore?: AuthProfileStore;
  includeExternalCli?: boolean;
}): AuthProfileStore | undefined {
  if (params.authStore) {
    return params.authStore;
  }
  const agentDir = params.agentDir?.trim();
  if (!agentDir) {
    return undefined;
  }
  return params.includeExternalCli
    ? ensureAuthProfileStore(agentDir, {
        externalCli: externalCliDiscoveryForProviderAuth({
          provider: params.provider,
          cfg: params.cfg,
        }),
      })
    : ensureAuthProfileStoreWithoutExternalProfiles(agentDir, {
        allowKeychainPrompt: false,
      });
}

function overlayExternalCliAuthStoreForProvider(params: {
  provider: string;
  authStore: AuthProfileStore;
}): AuthProfileStore {
  const profiles = resolveExternalCliAuthProfiles(params.authStore, {
    allowKeychainPrompt: false,
    providerIds: [params.provider],
  });
  if (profiles.length === 0) {
    return params.authStore;
  }
  return overlayRuntimeExternalOAuthProfiles(params.authStore, profiles);
}

function hasAuthProfileTypeInStore(params: {
  provider: string;
  cfg?: OpenClawConfig;
  store: AuthProfileStore;
  type: AuthProfileCredential["type"] | readonly AuthProfileCredential["type"][];
}): boolean {
  const types = Array.isArray(params.type) ? params.type : [params.type];
  return resolveAuthProfileOrder({
    cfg: params.cfg,
    store: params.store,
    provider: params.provider,
  }).some((profileId) => types.includes(params.store.profiles[profileId]?.type));
}

function hasAuthProfileTypeForProvider(params: {
  provider: string;
  cfg?: OpenClawConfig;
  agentDir?: string;
  authStore?: AuthProfileStore;
  includeExternalCli?: boolean;
  type: AuthProfileCredential["type"] | readonly AuthProfileCredential["type"][];
}): boolean {
  const store = loadAuthStoreForProvider(params);
  if (store && hasAuthProfileTypeInStore({ ...params, store })) {
    return true;
  }
  // Codex-harness tool construction can pass a scoped store with external CLI
  // profiles stripped. Keep that store authoritative, but still honor explicit
  // includeExternalCli lookups so Codex OAuth-only image routing remains visible.
  if (params.includeExternalCli && params.authStore) {
    const externalStore = overlayExternalCliAuthStoreForProvider({
      provider: params.provider,
      authStore: params.authStore,
    });
    return hasAuthProfileTypeInStore({ ...params, store: externalStore });
  }
  return false;
}

/** Returns whether a provider has direct API-key-capable auth for model-backed tools. */
function hasDirectProviderApiKeyAuthForTool(params: {
  provider: string;
  cfg?: OpenClawConfig;
  workspaceDir?: string;
  agentDir?: string;
  authStore?: AuthProfileStore;
  modelApi?: string;
}): boolean {
  const providerEntryProfileAuth = resolveDirectProviderEntryAuthFromProfileReference(params);
  if (providerEntryProfileAuth !== undefined) {
    return providerEntryProfileAuth;
  }
  if (
    hasRuntimeAvailableProviderAuth({
      provider: params.provider,
      cfg: params.cfg,
      workspaceDir: params.workspaceDir,
      modelApi: params.modelApi,
      allowPluginSyntheticAuth: false,
      // Without the store, inline provider keys in billing cooldown would
      // still be advertised as direct API-key auth for tools.
      store: loadAuthStoreForProvider(params),
    })
  ) {
    return true;
  }
  return hasAuthProfileTypeForProvider({
    provider: params.provider,
    cfg: params.cfg,
    agentDir: params.agentDir,
    authStore: params.authStore,
    type: "api_key",
  });
}

function resolveDirectProviderEntryAuthFromProfileReference(params: {
  provider: string;
  cfg?: OpenClawConfig;
  agentDir?: string;
  authStore?: AuthProfileStore;
}): boolean | undefined {
  const resolveFromStore = (store: AuthProfileStore): boolean | undefined => {
    const reference = resolveProviderEntryApiKeyProfileReference({
      cfg: params.cfg,
      provider: params.provider,
      store,
    });
    if (reference.kind === "profile") {
      return (
        reference.credential.type === "api_key" &&
        evaluateStoredCredentialEligibility({ credential: reference.credential }).eligible
      );
    }
    if (reference.kind === "profile-incompatible") {
      return false;
    }
    return undefined;
  };

  const store = loadAuthStoreForProvider({
    ...params,
    includeExternalCli: true,
  });
  const storeResult = store ? resolveFromStore(store) : undefined;
  if (storeResult !== undefined) {
    return storeResult;
  }
  if (params.authStore) {
    const externalStore = overlayExternalCliAuthStoreForProvider({
      provider: params.provider,
      authStore: params.authStore,
    });
    return resolveFromStore(externalStore);
  }
  return undefined;
}

/** Resolves the implicit OpenAI image slot without letting OAuth-only auth pick direct OpenAI. */
export function resolveOpenAiImageMediaCandidate(params: {
  cfg?: OpenClawConfig;
  workspaceDir?: string;
  agentDir: string;
  authStore?: AuthProfileStore;
  openAiModel: string;
  resolveCodexMediaRoute?: () => { model: string } | undefined;
}): OpenAiImageMediaCandidateDecision {
  const openAiModel = params.openAiModel.trim();
  if (!openAiModel) {
    return { kind: "drop" };
  }
  if (
    hasDirectProviderApiKeyAuthForTool({
      provider: OPENAI_PROVIDER_ID,
      cfg: params.cfg,
      workspaceDir: params.workspaceDir,
      agentDir: params.agentDir,
      authStore: params.authStore,
      modelApi: OPENAI_RESPONSES_MODEL_API,
    })
  ) {
    return {
      kind: "keep",
      ref: `${OPENAI_PROVIDER_ID}/${openAiModel}`,
    };
  }

  // Check canonical subscription auth before resolving plugin capability so a
  // fresh install cannot route there from bundled-plugin presence alone.
  if (
    !hasAuthProfileTypeForProvider({
      provider: OPENAI_PROVIDER_ID,
      cfg: params.cfg,
      agentDir: params.agentDir,
      authStore: params.authStore,
      includeExternalCli: true,
      type: ["oauth", "token"],
    })
  ) {
    return { kind: "drop" };
  }
  const codexModel = params.resolveCodexMediaRoute?.()?.model.trim();
  if (codexModel) {
    return {
      kind: "substitute",
      provider: CODEX_MEDIA_PROVIDER_ID,
      ref: `${CODEX_MEDIA_PROVIDER_ID}/${codexModel}`,
    };
  }

  return { kind: "drop" };
}

export function coerceToolModelConfig(model?: AgentToolModelConfig): ToolModelConfig {
  const primary = resolveAgentModelPrimaryValue(model);
  const fallbacks = resolveAgentModelFallbackValues(model);
  const timeoutMs = resolveAgentModelTimeoutMsValue(model);
  return {
    ...(primary?.trim() ? { primary: primary.trim() } : {}),
    ...(fallbacks.length > 0 ? { fallbacks } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  };
}

export function buildToolModelConfigFromCandidates(params: {
  explicit: ToolModelConfig;
  cfg?: OpenClawConfig;
  workspaceDir?: string;
  agentDir?: string;
  authStore?: AuthProfileStore;
  authProfileStoreSource?: boolean;
  candidates: Array<string | null | undefined>;
  isProviderConfigured?: (provider: string) => boolean | undefined;
}): ToolModelConfig | null {
  if (hasToolModelConfig(params.explicit)) {
    return params.explicit;
  }

  const deduped: string[] = [];
  for (const candidate of params.candidates) {
    const trimmed = candidate?.trim();
    if (!trimmed || !trimmed.includes("/")) {
      continue;
    }
    const provider = trimmed.slice(0, trimmed.indexOf("/")).trim();
    // Candidate defaults are only surfaced when the provider is configured or
    // has auth, so tools do not advertise unusable model refs.
    const providerConfigured =
      params.isProviderConfigured?.(provider) ??
      hasProviderAuthForTool({
        provider,
        cfg: params.cfg,
        workspaceDir: params.workspaceDir,
        agentDir: params.agentDir,
        authStore: params.authStore,
        authProfileStoreSource: params.authProfileStoreSource,
      });
    if (!provider || !providerConfigured) {
      continue;
    }
    if (!deduped.includes(trimmed)) {
      deduped.push(trimmed);
    }
  }

  if (deduped.length === 0) {
    return null;
  }

  return {
    primary: deduped[0],
    ...(deduped.length > 1 ? { fallbacks: deduped.slice(1) } : {}),
    ...(params.explicit.timeoutMs !== undefined ? { timeoutMs: params.explicit.timeoutMs } : {}),
  };
}

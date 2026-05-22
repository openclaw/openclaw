import {
  resolveAgentModelFallbackValues,
  resolveAgentModelPrimaryValue,
  resolveAgentModelTimeoutMsValue,
} from "../../config/model-input.js";
import type { AgentToolModelConfig } from "../../config/types.agents-shared.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { coerceSecretRef } from "../../config/types.secrets.js";
import { normalizeOptionalSecretInput } from "../../utils/normalize-secret-input.js";
import {
  externalCliDiscoveryForProviderAuth,
  ensureAuthProfileStore,
  hasAnyAuthProfileStoreSource,
  listProfilesForProvider,
} from "../auth-profiles.js";
import type { AuthProfileCredential, AuthProfileStore } from "../auth-profiles/types.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../defaults.js";
import {
  hasRuntimeAvailableProviderAuth,
  hasUsableCustomProviderApiKey,
  resolveEnvApiKey,
  resolveModelAuthMode,
} from "../model-auth.js";
import { resolveConfiguredModelRef } from "../model-selection.js";

export type ToolModelConfig = { primary?: string; fallbacks?: string[]; timeoutMs?: number };

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
  agentDir?: string;
  authStore?: AuthProfileStore;
}): boolean {
  if (resolveEnvApiKey(params.provider)?.apiKey) {
    return true;
  }
  if (params.authStore) {
    return hasUsableProfileForProvider({
      store: params.authStore,
      provider: params.provider,
      cfg: params.cfg,
    });
  }
  const agentDir = params.agentDir?.trim();
  if (!agentDir) {
    return false;
  }
  if (!hasAnyAuthProfileStoreSource(agentDir)) {
    return false;
  }
  const store = ensureAuthProfileStore(agentDir, {
    externalCli: externalCliDiscoveryForProviderAuth({ provider: params.provider }),
  });
  return hasUsableProfileForProvider({
    store,
    provider: params.provider,
    cfg: params.cfg,
  });
}

function hasUsableProfileForProvider(params: {
  store: AuthProfileStore;
  provider: string;
  cfg?: OpenClawConfig;
}): boolean {
  return listProfilesForProvider(params.store, params.provider).some((profileId) => {
    const credential = params.store.profiles[profileId];
    return Boolean(credential && hasUsableProfileCredential({ credential, cfg: params.cfg }));
  });
}

function hasUsableProfileCredential(params: {
  credential: AuthProfileCredential;
  cfg?: OpenClawConfig;
}): boolean {
  if (params.credential.type === "api_key") {
    return (
      hasAvailableProfileSecretInput({
        value: params.credential.key,
        cfg: params.cfg,
      }) ||
      hasAvailableProfileSecretInput({
        value: params.credential.keyRef,
        cfg: params.cfg,
      })
    );
  }
  if (params.credential.type === "token") {
    if (typeof params.credential.expires === "number" && params.credential.expires <= Date.now()) {
      return false;
    }
    return (
      hasAvailableProfileSecretInput({
        value: params.credential.token,
        cfg: params.cfg,
      }) ||
      hasAvailableProfileSecretInput({
        value: params.credential.tokenRef,
        cfg: params.cfg,
      })
    );
  }
  return Boolean(
    normalizeOptionalSecretInput(params.credential.access) ||
    normalizeOptionalSecretInput(params.credential.refresh) ||
    normalizeOptionalSecretInput(params.credential.idToken),
  );
}

function hasAvailableProfileSecretInput(params: { value: unknown; cfg?: OpenClawConfig }): boolean {
  const ref = coerceSecretRef(params.value, params.cfg?.secrets?.defaults);
  if (ref) {
    if (ref.source === "env") {
      return Boolean(normalizeOptionalSecretInput(process.env[ref.id]));
    }
    return true;
  }
  return Boolean(normalizeOptionalSecretInput(params.value));
}

export function hasProviderAuthForTool(params: {
  provider: string;
  cfg?: OpenClawConfig;
  workspaceDir?: string;
  agentDir?: string;
  authStore?: AuthProfileStore;
}): boolean {
  if (
    hasAuthForProvider({
      provider: params.provider,
      cfg: params.cfg,
      agentDir: params.agentDir,
      authStore: params.authStore,
    })
  ) {
    return true;
  }
  if (hasUsableCustomProviderApiKey(params.cfg, params.provider)) {
    return true;
  }
  if (
    resolveModelAuthMode(params.provider, params.cfg, params.authStore, {
      workspaceDir: params.workspaceDir,
    }) === "aws-sdk"
  ) {
    return false;
  }
  return hasRuntimeAvailableProviderAuth({
    provider: params.provider,
    cfg: params.cfg,
    workspaceDir: params.workspaceDir,
  });
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
  candidates: Array<string | null | undefined>;
  isProviderConfigured?: (provider: string) => boolean;
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
    const providerConfigured =
      params.isProviderConfigured?.(provider) ??
      hasProviderAuthForTool({
        provider,
        cfg: params.cfg,
        workspaceDir: params.workspaceDir,
        agentDir: params.agentDir,
        authStore: params.authStore,
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

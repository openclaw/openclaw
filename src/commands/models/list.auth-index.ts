import type { AuthProfileStore } from "../../agents/auth-profiles/types.js";
import {
  resolveProviderEnvApiKeyCandidates,
  resolveProviderEnvAuthEvidence,
} from "../../agents/model-auth-env-vars.js";
import { resolveEnvApiKey } from "../../agents/model-auth-env.js";
import { resolveAwsSdkEnvVarName } from "../../agents/model-auth-runtime-shared.js";
import {
  hasSyntheticLocalProviderAuthConfig,
  hasUsableCustomProviderApiKey,
} from "../../agents/model-auth.js";
import { resolveProviderAuthAliasMap } from "../../agents/provider-auth-aliases.js";
import { normalizeProviderIdForAuth } from "../../agents/provider-id.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { loadPluginRegistrySnapshotWithMetadata } from "../../plugins/plugin-registry.js";

export type ModelListAuthIndex = {
  hasProviderAuth(provider: string): boolean;
};

export type CreateModelListAuthIndexParams = {
  cfg: OpenClawConfig;
  authStore: AuthProfileStore;
  env?: NodeJS.ProcessEnv;
  syntheticAuthProviderRefs?: readonly string[];
};

export const EMPTY_MODEL_LIST_AUTH_INDEX: ModelListAuthIndex = {
  hasProviderAuth: () => false,
};

function normalizeAuthProvider(
  provider: string,
  aliasMap: Readonly<Record<string, string>>,
): string {
  const normalized = normalizeProviderIdForAuth(provider);
  return aliasMap[normalized] ?? normalized;
}

function listValidatedSyntheticAuthProviderRefs(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
}): readonly string[] {
  const result = loadPluginRegistrySnapshotWithMetadata({
    config: params.cfg,
    env: params.env,
  });
  if (result.source !== "persisted" && result.source !== "provided") {
    return [];
  }
  return result.snapshot.plugins
    .filter((plugin) => plugin.enabled)
    .flatMap((plugin) => plugin.syntheticAuthRefs ?? []);
}

export function createModelListAuthIndex(
  params: CreateModelListAuthIndexParams,
): ModelListAuthIndex {
  const env = params.env ?? process.env;
  const aliasMap = resolveProviderAuthAliasMap({ config: params.cfg, env });
  const envCandidateMap = resolveProviderEnvApiKeyCandidates({ config: params.cfg, env });
  const authEvidenceMap = resolveProviderEnvAuthEvidence({ config: params.cfg, env });
  const authenticatedProviders = new Set<string>();
  const syntheticAuthProviders = new Set<string>();
  const envProviderAuthCache = new Map<string, boolean>();
  const addProvider = (provider: string | undefined) => {
    if (!provider?.trim()) {
      return;
    }
    authenticatedProviders.add(normalizeAuthProvider(provider, aliasMap));
  };
  const addSyntheticProvider = (provider: string | undefined) => {
    const normalized = provider?.trim() ? normalizeProviderIdForAuth(provider) : "";
    if (!normalized) {
      return;
    }
    syntheticAuthProviders.add(normalized);
  };

  for (const credential of Object.values(params.authStore.profiles ?? {})) {
    addProvider(credential.provider);
  }

  for (const provider of new Set([
    ...Object.keys(envCandidateMap),
    ...Object.keys(authEvidenceMap),
  ])) {
    if (
      resolveEnvApiKey(provider, env, {
        aliasMap,
        candidateMap: envCandidateMap,
        authEvidenceMap,
      })
    ) {
      addProvider(provider);
    }
  }

  if (resolveAwsSdkEnvVarName(env)) {
    addProvider("amazon-bedrock");
  }

  for (const provider of Object.keys(params.cfg.models?.providers ?? {})) {
    if (
      hasUsableCustomProviderApiKey(params.cfg, provider, env) ||
      hasSyntheticLocalProviderAuthConfig({ cfg: params.cfg, provider })
    ) {
      addProvider(provider);
    }
  }

  for (const provider of params.syntheticAuthProviderRefs ??
    listValidatedSyntheticAuthProviderRefs({ cfg: params.cfg, env })) {
    addSyntheticProvider(provider);
  }

  const hasEnvProviderAuth = (provider: string): boolean => {
    const normalized = normalizeAuthProvider(provider, aliasMap);
    const cached = envProviderAuthCache.get(normalized);
    if (cached !== undefined) {
      return cached;
    }
    const hasAuth = Boolean(
      resolveEnvApiKey(provider, env, { aliasMap, candidateMap: envCandidateMap }),
    );
    envProviderAuthCache.set(normalized, hasAuth);
    if (hasAuth) {
      authenticatedProviders.add(normalized);
    }
    return hasAuth;
  };

  return {
    hasProviderAuth(provider: string): boolean {
      const normalizedProvider = normalizeAuthProvider(provider, aliasMap);
      return (
        authenticatedProviders.has(normalizedProvider) ||
        syntheticAuthProviders.has(normalizeProviderIdForAuth(provider)) ||
        hasEnvProviderAuth(provider)
      );
    },
  };
}

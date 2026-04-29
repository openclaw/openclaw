import type { AuthProfileStore } from "../../agents/auth-profiles/types.js";
import { resolveProviderEnvApiKeyCandidates } from "../../agents/model-auth-env-vars.js";
import { resolveEnvApiKey } from "../../agents/model-auth-env.js";
import { resolveAwsSdkEnvVarName } from "../../agents/model-auth-runtime-shared.js";
import { hasUsableCustomProviderApiKey } from "../../agents/model-auth.js";
import { resolveProviderAuthAliasMap } from "../../agents/provider-auth-aliases.js";
import { normalizeProviderIdForAuth } from "../../agents/provider-id.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { readPersistedInstalledPluginIndexSync } from "../../plugins/installed-plugin-index-store.js";

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

function listPersistedSyntheticAuthProviderRefs(): readonly string[] {
  const index = readPersistedInstalledPluginIndexSync();
  return index?.plugins.flatMap((plugin) => plugin.syntheticAuthRefs ?? []) ?? [];
}

export function createModelListAuthIndex(
  params: CreateModelListAuthIndexParams,
): ModelListAuthIndex {
  const env = params.env ?? process.env;
  const aliasMap = resolveProviderAuthAliasMap({ config: params.cfg, env });
  const envCandidateMap = resolveProviderEnvApiKeyCandidates({ config: params.cfg, env });
  const authenticatedProviders = new Set<string>();
  const addProvider = (provider: string | undefined) => {
    if (!provider?.trim()) {
      return;
    }
    authenticatedProviders.add(normalizeAuthProvider(provider, aliasMap));
  };

  for (const credential of Object.values(params.authStore.profiles ?? {})) {
    addProvider(credential.provider);
  }

  for (const provider of Object.keys(envCandidateMap)) {
    if (resolveEnvApiKey(provider, env, { aliasMap, candidateMap: envCandidateMap })) {
      addProvider(provider);
    }
  }

  if (resolveAwsSdkEnvVarName(env)) {
    addProvider("amazon-bedrock");
  }

  for (const provider of Object.keys(params.cfg.models?.providers ?? {})) {
    if (hasUsableCustomProviderApiKey(params.cfg, provider, env)) {
      addProvider(provider);
    }
  }

  for (const provider of params.syntheticAuthProviderRefs ??
    listPersistedSyntheticAuthProviderRefs()) {
    addProvider(provider);
  }

  return {
    hasProviderAuth(provider: string): boolean {
      return authenticatedProviders.has(normalizeAuthProvider(provider, aliasMap));
    },
  };
}

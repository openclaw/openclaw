import type { AuthProfileStore } from "../../agents/auth-profiles/types.js";
import { resolveProviderEnvApiKeyCandidates } from "../../agents/model-auth-env-vars.js";
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
  const authenticatedProviders = new Set<string>();
  const syntheticAuthProviders = new Set<string>();
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

  for (const provider of Object.keys(envCandidateMap)) {
    if (resolveEnvApiKey(provider, env, { aliasMap, candidateMap: envCandidateMap })) {
      addProvider(provider);
    }
  }
  // Google Vertex ADC is still represented by resolveEnvApiKey's compatibility
  // path. Move this into manifest auth signals once that contract exists.
  if (resolveEnvApiKey("google-vertex", env, { aliasMap, candidateMap: envCandidateMap })) {
    addProvider("google-vertex");
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

  return {
    hasProviderAuth(provider: string): boolean {
      return (
        authenticatedProviders.has(normalizeAuthProvider(provider, aliasMap)) ||
        syntheticAuthProviders.has(normalizeProviderIdForAuth(provider))
      );
    },
  };
}

import type { OpenClawConfig } from "../../config/config.js";
import type { RuntimeEnv } from "../../runtime.js";
import {
  ensureAuthProfileStore,
  resolveApiKeyForProfile,
  resolveAuthProfileOrder,
} from "../../agents/auth-profiles.js";
import { resolveEnvApiKey } from "../../agents/model-auth.js";
import { normalizeOptionalSecretInput } from "../../utils/normalize-secret-input.js";

export type NonInteractiveApiKeySource = "flag" | "env" | "profile";

async function resolveApiKeyFromProfiles(params: {
  provider: string;
  cfg: OpenClawConfig;
  agentDir?: string;
}): Promise<string | null> {
  const store = ensureAuthProfileStore(params.agentDir);
  const order = resolveAuthProfileOrder({
    cfg: params.cfg,
    store,
    provider: params.provider,
  });
  for (const profileId of order) {
    const cred = store.profiles[profileId];
    if (cred?.type !== "api_key") {
      continue;
    }
    const resolved = await resolveApiKeyForProfile({
      cfg: params.cfg,
      store,
      profileId,
      agentDir: params.agentDir,
    });
    if (resolved?.apiKey) {
      return resolved.apiKey;
    }
  }
  return null;
}

export async function resolveNonInteractiveApiKey(params: {
  provider: string;
  cfg: OpenClawConfig;
  flagValue?: string;
  flagName: string;
  envVar: string;
  envVarName?: string;
  runtime: RuntimeEnv;
  agentDir?: string;
  allowProfile?: boolean;
  required?: boolean;
}): Promise<{ key: string; source: NonInteractiveApiKeySource } | null> {
  const flagKey = normalizeOptionalSecretInput(params.flagValue);
  if (flagKey) {
    return { key: flagKey, source: "flag" };
  }

  const envResolved = resolveEnvApiKey(params.provider);
  if (envResolved?.apiKey) {
    return { key: envResolved.apiKey, source: "env" };
  }

  const explicitEnvVar = params.envVarName?.trim();
  if (explicitEnvVar) {
    const explicitEnvKey = normalizeOptionalSecretInput(process.env[explicitEnvVar]);
    if (explicitEnvKey) {
      return { key: explicitEnvKey, source: "env" };
    }
  }

  if (params.allowProfile ?? true) {
    const profileKey = await resolveApiKeyFromProfiles({
      provider: params.provider,
      cfg: params.cfg,
      agentDir: params.agentDir,
    });
    if (profileKey) {
      return { key: profileKey, source: "profile" };
    }
  }

  if (params.required === false) {
    return null;
  }

  const profileHint =
    params.allowProfile === false ? "" : `, or existing ${params.provider} API-key profile`;
  params.runtime.error(`Missing ${params.flagName} (or ${params.envVar} in env${profileHint}).`);
  params.runtime.exit(1);
  return null;
}

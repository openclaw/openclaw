import {
  loadAuthProfileStoreForSecretsRuntime,
  resolveAuthProfileOrder,
} from "../../../agents/auth-profiles.js";
import { resolveGigachatAuthMode } from "../../../agents/gigachat-auth.js";
import type { OpenClawConfig } from "../../../config/config.js";
import type { SecretInput } from "../../../config/types.secrets.js";
import { applyAuthProfileConfig } from "../../../plugins/provider-auth-helpers.js";
import { setGigachatApiKey, setLitellmApiKey } from "../../../plugins/provider-auth-storage.js";
import type { RuntimeEnv } from "../../../runtime.js";
import { applyGigachatConfig } from "../../onboard-auth.config-core.js";
import { applyLitellmConfig } from "../../onboard-auth.config-litellm.js";
import { GIGACHAT_BASE_URL } from "../../onboard-auth.models.js";
import type { AuthChoice, OnboardOptions } from "../../onboard-types.js";

type ApiKeyStorageOptions = {
  secretInputMode: "plaintext" | "ref";
};

type ResolvedNonInteractiveApiKey = {
  key: string;
  source: "profile" | "env" | "flag";
  profileId?: string;
  metadata?: Record<string, string>;
};

function hasActiveGigachatBasicProfile(cfg: OpenClawConfig, agentDir?: string): boolean {
  const store = loadAuthProfileStoreForSecretsRuntime(agentDir);
  const activeProfileId = resolveAuthProfileOrder({ cfg, store, provider: "gigachat" })[0];
  const profile = activeProfileId ? store.profiles[activeProfileId] : undefined;
  return (
    profile?.type === "api_key" &&
    profile.provider === "gigachat" &&
    profile.metadata?.authMode === "basic"
  );
}

async function applyGigachatNonInteractiveApiKeyChoice(params: {
  nextConfig: OpenClawConfig;
  baseConfig: OpenClawConfig;
  opts: OnboardOptions;
  runtime: RuntimeEnv;
  agentDir?: string;
  apiKeyStorageOptions?: ApiKeyStorageOptions;
  resolveApiKey: (input: {
    provider: string;
    cfg: OpenClawConfig;
    flagValue?: string;
    flagName: `--${string}`;
    envVar: string;
    runtime: RuntimeEnv;
    agentDir?: string;
    allowProfile?: boolean;
  }) => Promise<ResolvedNonInteractiveApiKey | null>;
  maybeSetResolvedApiKey: (
    resolved: ResolvedNonInteractiveApiKey,
    setter: (value: SecretInput) => Promise<void> | void,
  ) => Promise<boolean>;
}): Promise<OpenClawConfig | null> {
  const resetGigachatBaseUrl = hasActiveGigachatBasicProfile(params.baseConfig, params.agentDir);
  const resolved = await params.resolveApiKey({
    provider: "gigachat",
    cfg: params.baseConfig,
    flagValue: params.opts.gigachatApiKey ?? params.opts.token,
    flagName: "--gigachat-api-key",
    envVar: "GIGACHAT_CREDENTIALS",
    runtime: params.runtime,
    agentDir: params.agentDir,
    // Allow existing OAuth profiles to be reused, but reject Basic-shaped
    // credentials below before any OAuth metadata/config rewrite happens.
    allowProfile: true,
  });
  if (!resolved) {
    return null;
  }
  if (resolveGigachatAuthMode({ apiKey: resolved.key }) === "basic") {
    params.runtime.error(
      [
        "GIGACHAT_CREDENTIALS looks like Basic user:password credentials.",
        'Non-interactive "--gigachat-api-key" only supports personal OAuth credentials keys.',
        "Set GIGACHAT_CREDENTIALS to a real OAuth credentials key and retry.",
      ].join("\n"),
    );
    params.runtime.exit(1);
    return null;
  }
  if (
    resolved.source === "profile" &&
    resolved.metadata?.scope &&
    resolved.metadata.scope !== "GIGACHAT_API_PERS"
  ) {
    params.runtime.error(
      [
        `Stored GigaChat profile "${resolved.profileId ?? "gigachat profile"}" is scoped for business billing (${resolved.metadata.scope}).`,
        'Non-interactive "--gigachat-api-key" only supports personal OAuth credentials keys.',
        "Use a personal-scope key/profile for this path, or run interactive onboarding for business GigaChat setup.",
      ].join("\n"),
    );
    params.runtime.exit(1);
    return null;
  }
  if (
    !(await params.maybeSetResolvedApiKey(resolved, (value) =>
      setGigachatApiKey(value, params.agentDir, params.apiKeyStorageOptions, {
        authMode: "oauth",
        scope: "GIGACHAT_API_PERS",
      }),
    ))
  ) {
    return null;
  }
  return applyGigachatConfig(
    applyAuthProfileConfig(params.nextConfig, {
      profileId: "gigachat:default",
      provider: "gigachat",
      mode: "api_key",
    }),
    resetGigachatBaseUrl ? { baseUrl: GIGACHAT_BASE_URL } : undefined,
  );
}

export async function applySimpleNonInteractiveApiKeyChoice(params: {
  authChoice: AuthChoice;
  nextConfig: OpenClawConfig;
  baseConfig: OpenClawConfig;
  opts: OnboardOptions;
  runtime: RuntimeEnv;
  agentDir?: string;
  apiKeyStorageOptions?: ApiKeyStorageOptions;
  resolveApiKey: (input: {
    provider: string;
    cfg: OpenClawConfig;
    flagValue?: string;
    flagName: `--${string}`;
    envVar: string;
    runtime: RuntimeEnv;
    agentDir?: string;
    allowProfile?: boolean;
  }) => Promise<ResolvedNonInteractiveApiKey | null>;
  maybeSetResolvedApiKey: (
    resolved: ResolvedNonInteractiveApiKey,
    setter: (value: SecretInput) => Promise<void> | void,
  ) => Promise<boolean>;
}): Promise<OpenClawConfig | null | undefined> {
  if (params.authChoice === "gigachat-api-key" || params.authChoice === "gigachat-oauth") {
    return applyGigachatNonInteractiveApiKeyChoice(params);
  }

  if (params.authChoice !== "litellm-api-key") {
    return undefined;
  }

  const resolved = await params.resolveApiKey({
    provider: "litellm",
    cfg: params.baseConfig,
    flagValue: params.opts.litellmApiKey,
    flagName: "--litellm-api-key",
    envVar: "LITELLM_API_KEY",
    runtime: params.runtime,
    agentDir: params.agentDir,
  });
  if (!resolved) {
    return null;
  }
  if (
    !(await params.maybeSetResolvedApiKey(resolved, (value) =>
      setLitellmApiKey(value, params.agentDir, params.apiKeyStorageOptions),
    ))
  ) {
    return null;
  }
  return applyLitellmConfig(
    applyAuthProfileConfig(params.nextConfig, {
      profileId: "litellm:default",
      provider: "litellm",
      mode: "api_key",
    }),
  );
}

import type { OpenClawConfig } from "../../../config/config.js";
import type { SecretInput } from "../../../config/types.secrets.js";
import type { RuntimeEnv } from "../../../runtime.js";
import {
  applyAuthProfileConfig,
  applyLitellmConfig,
  setLitellmApiKey,
} from "../../onboard-auth.js";
import type { AuthChoice, OnboardOptions } from "../../onboard-types.js";

type ApiKeyStorageOptions = {
  secretInputMode: "plaintext" | "ref";
};

type ResolvedNonInteractiveApiKey = {
  key: string;
  source: "profile" | "env" | "flag";
};

export async function applySimpleNonInteractiveApiKeyChoice(params: {
  authChoice: AuthChoice;
  nextConfig: OpenClawConfig;
  baseConfig: OpenClawConfig;
  opts: OnboardOptions;
  runtime: RuntimeEnv;
  apiKeyStorageOptions?: ApiKeyStorageOptions;
  resolveApiKey: (input: {
    provider: string;
    cfg: OpenClawConfig;
    flagValue?: string;
    flagName: `--${string}`;
    envVar: string;
    runtime: RuntimeEnv;
  }) => Promise<ResolvedNonInteractiveApiKey | null>;
  maybeSetResolvedApiKey: (
    resolved: ResolvedNonInteractiveApiKey,
    setter: (value: SecretInput) => Promise<void> | void,
  ) => Promise<boolean>;
}): Promise<OpenClawConfig | null | undefined> {
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
  });
  if (!resolved) {
    return null;
  }
  if (
    !(await params.maybeSetResolvedApiKey(resolved, (value) =>
      setLitellmApiKey(value, undefined, params.apiKeyStorageOptions),
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

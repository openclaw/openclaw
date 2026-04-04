import type { OpenClawConfig } from "../config/config.js";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import type { AuthChoice, OnboardOptions } from "./onboard-types.js";
import { applyAuthChoiceLoadedPluginProvider } from "../plugins/provider-auth-choice.js";
import { normalizeLegacyOnboardAuthChoice } from "./auth-choice-legacy.js";
import { applyAuthChoiceApiProviders } from "./auth-choice.apply.api-providers.js";
import { normalizeApiKeyTokenProviderAuthChoice } from "./auth-choice.apply.api-providers.js";
import { applyAuthChoiceOAuth } from "./auth-choice.apply.oauth.js";

export type ApplyAuthChoiceParams = {
  authChoice: AuthChoice;
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  prompter: WizardPrompter;
  runtime: RuntimeEnv;
  agentDir?: string;
  setDefaultModel: boolean;
  agentId?: string;
  opts?: Partial<OnboardOptions>;
};

export type ApplyAuthChoiceResult = {
  config: OpenClawConfig;
  agentModelOverride?: string;
};

export async function applyAuthChoice(
  params: ApplyAuthChoiceParams,
): Promise<ApplyAuthChoiceResult> {
  const normalizedAuthChoice =
    normalizeLegacyOnboardAuthChoice(params.authChoice, {
      config: params.config,
      env: params.env,
    }) ?? params.authChoice;
  const normalizedProviderAuthChoice = normalizeApiKeyTokenProviderAuthChoice({
    authChoice: normalizedAuthChoice,
    tokenProvider: params.opts?.tokenProvider,
    config: params.config,
    env: params.env,
  });
  const normalizedParams =
    normalizedProviderAuthChoice === params.authChoice
      ? params
      : { ...params, authChoice: normalizedProviderAuthChoice };
  const handlers: Array<(p: ApplyAuthChoiceParams) => Promise<ApplyAuthChoiceResult | null>> = [
    applyAuthChoiceLoadedPluginProvider,
    applyAuthChoiceOAuth,
    applyAuthChoiceApiProviders,
  ];

  for (const handler of handlers) {
    const result = await handler(normalizedParams);
    if (result) {
      return result;
    }
  }

  if (
    normalizedParams.authChoice === "token" ||
    normalizedParams.authChoice === "setup-token" ||
    normalizedParams.authChoice === "oauth"
  ) {
    throw new Error(
      [
        `Auth choice "${normalizedParams.authChoice}" is no longer supported for Anthropic setup in OpenClaw.`,
        "Existing Anthropic token profiles still run if they are already configured.",
        'Use "anthropic-cli" or "apiKey" instead.',
      ].join("\n"),
    );
  }

  return { config: normalizedParams.config };
}

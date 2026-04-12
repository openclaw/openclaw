import { applyAuthChoiceLoadedPluginProvider } from "../plugins/provider-auth-choice.js";
import { normalizeLegacyOnboardAuthChoice } from "./auth-choice-legacy.js";
import { applyAuthChoiceApiProviders } from "./auth-choice.apply.api-providers.js";
import { normalizeApiKeyTokenProviderAuthChoice } from "./auth-choice.apply.api-providers.js";
import { applyAuthChoiceOAuth } from "./auth-choice.apply.oauth.js";
import type { ApplyAuthChoiceParams, ApplyAuthChoiceResult } from "./auth-choice.apply.types.js";

export type { ApplyAuthChoiceParams, ApplyAuthChoiceResult } from "./auth-choice.apply.types.js";

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

  if (normalizedParams.authChoice === "token" || normalizedParams.authChoice === "setup-token") {
    throw new Error(
      [
        `Auth choice "${normalizedParams.authChoice}" was not matched to a provider setup flow.`,
        'For Anthropic legacy token auth, use "setup-token" with tokenProvider="anthropic" or choose the Anthropic setup-token entry explicitly.',
      ].join("\n"),
    );
  }

  if (normalizedParams.authChoice === "oauth") {
    throw new Error(
      'Auth choice "oauth" is no longer supported directly. Use "setup-token" for Anthropic legacy token auth or a provider-specific OAuth entry.',
    );
  }

  return { config: normalizedParams.config };
}

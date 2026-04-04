import { resolveManifestProviderApiKeyChoice } from "../plugins/provider-auth-choices.js";
import { normalizeTokenProviderInput } from "./auth-choice.apply-helpers.js";
import type { ApplyAuthChoiceParams, ApplyAuthChoiceResult } from "./auth-choice.apply.js";
import type { AuthChoice } from "./onboard-types.js";

export function normalizeApiKeyTokenProviderAuthChoice(params: {
  authChoice: AuthChoice;
  tokenProvider?: string;
  config?: ApplyAuthChoiceParams["config"];
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): AuthChoice {
  if (params.authChoice !== "apiKey" || !params.tokenProvider) {
    return params.authChoice;
  }
  const normalizedTokenProvider = normalizeTokenProviderInput(params.tokenProvider);
  if (!normalizedTokenProvider) {
    return params.authChoice;
  }
  return (
    (resolveManifestProviderApiKeyChoice({
      providerId: normalizedTokenProvider,
      config: params.config,
      workspaceDir: params.workspaceDir,
      env: params.env,
    })?.choiceId as AuthChoice | undefined) ?? params.authChoice
  );
}

export async function applyAuthChoiceApiProviders(
  _params: ApplyAuthChoiceParams,
): Promise<ApplyAuthChoiceResult | null> {
  return null;
}

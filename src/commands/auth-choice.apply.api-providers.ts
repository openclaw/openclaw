// Token-provider normalization hooks for provider-backed auth choices.
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { resolveProviderMatch } from "../plugins/provider-auth-choice-helpers.js";
import { resolvePluginProviders } from "../plugins/provider-auth-choice.runtime.js";
import type { ApplyAuthChoiceParams } from "./auth-choice.apply.types.js";
import type { AuthChoice } from "./onboard-types.js";

/** Translate generic api-key/token choices to provider-specific auth choices when possible. */
export function normalizeApiKeyTokenProviderAuthChoice(params: {
  authChoice: AuthChoice;
  tokenProvider?: string;
  config?: ApplyAuthChoiceParams["config"];
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): AuthChoice {
  const normalizedTokenProvider = normalizeOptionalLowercaseString(params.tokenProvider);
  if (!normalizedTokenProvider) {
    return params.authChoice;
  }
  const kind =
    params.authChoice === "apiKey"
      ? "api_key"
      : params.authChoice === "token" || params.authChoice === "setup-token"
        ? "token"
        : undefined;
  if (!kind) {
    return params.authChoice;
  }
  const provider = resolveProviderMatch(
    resolvePluginProviders({
      config: params.config,
      workspaceDir: params.workspaceDir,
      env: params.env,
      mode: "setup",
    }),
    normalizedTokenProvider,
  );
  return (
    provider?.auth.find((method) => method.kind === kind)?.wizard?.choiceId ?? params.authChoice
  );
}

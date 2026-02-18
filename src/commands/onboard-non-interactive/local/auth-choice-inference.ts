import { ONBOARD_PROVIDER_AUTH_FLAGS } from "../../onboard-provider-auth-flags.js";
import type { AuthChoice, OnboardOptions } from "../../onboard-types.js";

type AuthChoiceFlag = {
  optionKey: keyof AuthChoiceFlagOptions;
  authChoice: AuthChoice;
  label: string;
};

type AuthChoiceFlagOptions = Pick<
  OnboardOptions,
  | "anthropicApiKey"
  | "geminiApiKey"
  | "openaiApiKey"
  | "openrouterApiKey"
  | "aiGatewayApiKey"
  | "cloudflareAiGatewayApiKey"
  | "moonshotApiKey"
  | "kimiCodeApiKey"
  | "syntheticApiKey"
  | "veniceApiKey"
  | "togetherApiKey"
  | "huggingfaceApiKey"
  | "zaiApiKey"
  | "xiaomiApiKey"
  | "minimaxApiKey"
  | "opencodeZenApiKey"
  | "xaiApiKey"
  | "litellmApiKey"
  | "qianfanApiKey"
  | "customBaseUrl"
  | "customModelId"
  | "customApiKey"
>;

export type AuthChoiceInference = {
  choice?: AuthChoice;
  matches: AuthChoiceFlag[];
};

function hasStringValue(value: unknown): boolean {
  return typeof value === "string" ? value.trim().length > 0 : Boolean(value);
}

// Infer auth choice from explicit provider API key flags.
export function inferAuthChoiceFromFlags(opts: OnboardOptions): AuthChoiceInference {
  const matches: AuthChoiceFlag[] = ONBOARD_PROVIDER_AUTH_FLAGS.filter(({ optionKey }) =>
    hasStringValue(opts[optionKey]),
  ).map((flag) => ({
    optionKey: flag.optionKey,
    authChoice: flag.authChoice,
    label: flag.cliFlag,
  }));

  if (
    hasStringValue(opts.customBaseUrl) ||
    hasStringValue(opts.customModelId) ||
    hasStringValue(opts.customApiKey)
  ) {
    matches.push({
      optionKey: "customBaseUrl",
      authChoice: "custom-api-key",
      label: "--custom-base-url/--custom-model-id/--custom-api-key",
    });
  }

  return {
    choice: matches[0]?.authChoice,
    matches,
  };
}

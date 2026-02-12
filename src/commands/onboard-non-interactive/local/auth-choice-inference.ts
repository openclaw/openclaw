import type { AuthChoice, OnboardOptions } from "../../onboard-types.js";

type AuthChoiceFlag = {
  flag: keyof AuthChoiceFlagOptions;
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
  | "customBaseUrl"
  | "customModelId"
  | "customApiKey"
>;

const AUTH_CHOICE_FLAG_MAP = [
  { flag: "anthropicApiKey", authChoice: "apiKey", label: "--anthropic-api-key" },
  { flag: "geminiApiKey", authChoice: "gemini-api-key", label: "--gemini-api-key" },
  { flag: "openaiApiKey", authChoice: "openai-api-key", label: "--openai-api-key" },
  { flag: "openrouterApiKey", authChoice: "openrouter-api-key", label: "--openrouter-api-key" },
  { flag: "aiGatewayApiKey", authChoice: "ai-gateway-api-key", label: "--ai-gateway-api-key" },
  {
    flag: "cloudflareAiGatewayApiKey",
    authChoice: "cloudflare-ai-gateway-api-key",
    label: "--cloudflare-ai-gateway-api-key",
  },
  { flag: "moonshotApiKey", authChoice: "moonshot-api-key", label: "--moonshot-api-key" },
  { flag: "kimiCodeApiKey", authChoice: "kimi-code-api-key", label: "--kimi-code-api-key" },
  { flag: "syntheticApiKey", authChoice: "synthetic-api-key", label: "--synthetic-api-key" },
  { flag: "veniceApiKey", authChoice: "venice-api-key", label: "--venice-api-key" },
  { flag: "togetherApiKey", authChoice: "together-api-key", label: "--together-api-key" },
  { flag: "zaiApiKey", authChoice: "zai-api-key", label: "--zai-api-key" },
  { flag: "xiaomiApiKey", authChoice: "xiaomi-api-key", label: "--xiaomi-api-key" },
  { flag: "xaiApiKey", authChoice: "xai-api-key", label: "--xai-api-key" },
  { flag: "minimaxApiKey", authChoice: "minimax-api", label: "--minimax-api-key" },
  { flag: "opencodeZenApiKey", authChoice: "opencode-zen", label: "--opencode-zen-api-key" },
  { flag: "huggingfaceApiKey", authChoice: "huggingface-api-key", label: "--huggingface-api-key" },
  { flag: "litellmApiKey", authChoice: "litellm-api-key", label: "--litellm-api-key" },
] satisfies ReadonlyArray<AuthChoiceFlag>;

export type AuthChoiceInference = {
  choice?: AuthChoice;
  matches: AuthChoiceFlag[];
};

function hasStringValue(value: unknown): boolean {
  return typeof value === "string" ? value.trim().length > 0 : Boolean(value);
}

// Infer auth choice from explicit provider API key flags.
export function inferAuthChoiceFromFlags(opts: OnboardOptions): AuthChoiceInference {
  const matches: AuthChoiceFlag[] = AUTH_CHOICE_FLAG_MAP.filter(({ flag }) =>
    hasStringValue(opts[flag]),
  );

  if (
    hasStringValue(opts.customBaseUrl) ||
    hasStringValue(opts.customModelId) ||
    hasStringValue(opts.customApiKey)
  ) {
    matches.push({
      flag: "customBaseUrl",
      authChoice: "custom-api-key",
      label: "--custom-base-url/--custom-model-id/--custom-api-key",
    });
  }

  return {
    choice: matches[0]?.authChoice,
    matches,
  };
}

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
  | "zaiApiKey"
  | "xiaomiApiKey"
  | "minimaxApiKey"
  | "opencodeZenApiKey"
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
  { flag: "zaiApiKey", authChoice: "zai-api-key", label: "--zai-api-key" },
  { flag: "xiaomiApiKey", authChoice: "xiaomi-api-key", label: "--xiaomi-api-key" },
  { flag: "minimaxApiKey", authChoice: "minimax-api", label: "--minimax-api-key" },
  { flag: "opencodeZenApiKey", authChoice: "opencode-zen", label: "--opencode-zen-api-key" },
] satisfies ReadonlyArray<AuthChoiceFlag>;

export type AuthChoiceInference = {
  choice?: AuthChoice;
  matches: AuthChoiceFlag[];
};

// Infer auth choice from explicit provider API key flags.
export function inferAuthChoiceFromFlags(opts: OnboardOptions): AuthChoiceInference {
  const matches = AUTH_CHOICE_FLAG_MAP.filter(({ flag }) => {
    const value = opts[flag];
    if (typeof value === "string") {
      return value.trim().length > 0;
    }
    return Boolean(value);
  });

  return {
    choice: matches[0]?.authChoice,
    matches,
  };
}

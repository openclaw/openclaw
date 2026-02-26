import type { AuthChoice, OnboardOptions } from "./onboard-types.js";

type OnboardProviderAuthOptionKey = keyof Pick<
  OnboardOptions,
  | "anthropicApiKey"
  | "openaiApiKey"
  | "mistralApiKey"
  | "openrouterApiKey"
  | "kilocodeApiKey"
  | "aiGatewayApiKey"
  | "cloudflareAiGatewayApiKey"
  | "moonshotApiKey"
  | "kimiCodeApiKey"
  | "stepfunApiKey"
  | "geminiApiKey"
  | "zaiApiKey"
  | "xiaomiApiKey"
  | "minimaxApiKey"
  | "syntheticApiKey"
  | "veniceApiKey"
  | "togetherApiKey"
  | "huggingfaceApiKey"
  | "opencodeZenApiKey"
  | "xaiApiKey"
  | "litellmApiKey"
  | "qianfanApiKey"
  | "volcengineApiKey"
  | "byteplusApiKey"
>;

export type OnboardProviderAuthFlag = {
  optionKey: OnboardProviderAuthOptionKey;
  authChoice: AuthChoice;
  cliFlag: `--${string}`;
  cliOption: `--${string} <key>`;
  description: string;
};

// Shared source for provider API-key flags used by CLI registration + non-interactive inference.
export const ONBOARD_PROVIDER_AUTH_FLAGS: ReadonlyArray<OnboardProviderAuthFlag> = [
  {
    optionKey: "anthropicApiKey",
    authChoice: "apiKey",
    cliFlag: "--anthropic-api-key",
    cliOption: "--anthropic-api-key <key>",
    description: "Anthropic API key",
  },
  {
    optionKey: "openaiApiKey",
    authChoice: "openai-api-key",
    cliFlag: "--openai-api-key",
    cliOption: "--openai-api-key <key>",
    description: "OpenAI API key",
  },
  {
    optionKey: "mistralApiKey",
    authChoice: "mistral-api-key",
    cliFlag: "--mistral-api-key",
    cliOption: "--mistral-api-key <key>",
    description: "Mistral API key",
  },
  {
    optionKey: "openrouterApiKey",
    authChoice: "openrouter-api-key",
    cliFlag: "--openrouter-api-key",
    cliOption: "--openrouter-api-key <key>",
    description: "OpenRouter API key",
  },
  {
    optionKey: "kilocodeApiKey",
    authChoice: "kilocode-api-key",
    cliFlag: "--kilocode-api-key",
    cliOption: "--kilocode-api-key <key>",
    description: "Kilo Gateway API key",
  },
  {
    optionKey: "aiGatewayApiKey",
    authChoice: "ai-gateway-api-key",
    cliFlag: "--ai-gateway-api-key",
    cliOption: "--ai-gateway-api-key <key>",
    description: "Vercel AI Gateway API key",
  },
  {
    optionKey: "cloudflareAiGatewayApiKey",
    authChoice: "cloudflare-ai-gateway-api-key",
    cliFlag: "--cloudflare-ai-gateway-api-key",
    cliOption: "--cloudflare-ai-gateway-api-key <key>",
    description: "Cloudflare AI Gateway API key",
  },
  {
    optionKey: "moonshotApiKey",
    authChoice: "moonshot-api-key",
    cliFlag: "--moonshot-api-key",
    cliOption: "--moonshot-api-key <key>",
    description: "Moonshot API key",
  },
  {
    optionKey: "kimiCodeApiKey",
    authChoice: "kimi-code-api-key",
    cliFlag: "--kimi-code-api-key",
    cliOption: "--kimi-code-api-key <key>",
    description: "Kimi Coding API key",
  },
  {
    optionKey: "stepfunApiKey",
    authChoice: "stepfun-api-key",
    cliFlag: "--stepfun-api-key",
    cliOption: "--stepfun-api-key <key>",
    description: "StepFun API key",
  },
  {
    optionKey: "geminiApiKey",
    authChoice: "gemini-api-key",
    cliFlag: "--gemini-api-key",
    cliOption: "--gemini-api-key <key>",
    description: "Gemini API key",
  },
  {
    optionKey: "zaiApiKey",
    authChoice: "zai-api-key",
    cliFlag: "--zai-api-key",
    cliOption: "--zai-api-key <key>",
    description: "Z.AI API key",
  },
  {
    optionKey: "xiaomiApiKey",
    authChoice: "xiaomi-api-key",
    cliFlag: "--xiaomi-api-key",
    cliOption: "--xiaomi-api-key <key>",
    description: "Xiaomi API key",
  },
  {
    optionKey: "minimaxApiKey",
    authChoice: "minimax-api",
    cliFlag: "--minimax-api-key",
    cliOption: "--minimax-api-key <key>",
    description: "MiniMax API key",
  },
  {
    optionKey: "syntheticApiKey",
    authChoice: "synthetic-api-key",
    cliFlag: "--synthetic-api-key",
    cliOption: "--synthetic-api-key <key>",
    description: "Synthetic API key",
  },
  {
    optionKey: "veniceApiKey",
    authChoice: "venice-api-key",
    cliFlag: "--venice-api-key",
    cliOption: "--venice-api-key <key>",
    description: "Venice API key",
  },
  {
    optionKey: "togetherApiKey",
    authChoice: "together-api-key",
    cliFlag: "--together-api-key",
    cliOption: "--together-api-key <key>",
    description: "Together AI API key",
  },
  {
    optionKey: "huggingfaceApiKey",
    authChoice: "huggingface-api-key",
    cliFlag: "--huggingface-api-key",
    cliOption: "--huggingface-api-key <key>",
    description: "Hugging Face API key (HF token)",
  },
  {
    optionKey: "opencodeZenApiKey",
    authChoice: "opencode-zen",
    cliFlag: "--opencode-zen-api-key",
    cliOption: "--opencode-zen-api-key <key>",
    description: "OpenCode Zen API key",
  },
  {
    optionKey: "xaiApiKey",
    authChoice: "xai-api-key",
    cliFlag: "--xai-api-key",
    cliOption: "--xai-api-key <key>",
    description: "xAI API key",
  },
  {
    optionKey: "litellmApiKey",
    authChoice: "litellm-api-key",
    cliFlag: "--litellm-api-key",
    cliOption: "--litellm-api-key <key>",
    description: "LiteLLM API key",
  },
  {
    optionKey: "qianfanApiKey",
    authChoice: "qianfan-api-key",
    cliFlag: "--qianfan-api-key",
    cliOption: "--qianfan-api-key <key>",
    description: "QIANFAN API key",
  },
  {
    optionKey: "volcengineApiKey",
    authChoice: "volcengine-api-key",
    cliFlag: "--volcengine-api-key",
    cliOption: "--volcengine-api-key <key>",
    description: "Volcano Engine API key",
  },
  {
    optionKey: "byteplusApiKey",
    authChoice: "byteplus-api-key",
    cliFlag: "--byteplus-api-key",
    cliOption: "--byteplus-api-key <key>",
    description: "BytePlus API key",
  },
];

import type { AuthProfileStore } from "../agents/auth-profiles.js";
import type { AuthChoice, AuthChoiceGroupId } from "./onboard-types.js";
import { AUTH_CHOICE_LEGACY_ALIASES_FOR_CLI } from "./auth-choice-legacy.js";

export type { AuthChoiceGroupId };

export type AuthChoiceOption = {
  value: AuthChoice;
  label: string;
  hint?: string;
};
export type AuthChoiceGroup = {
  value: AuthChoiceGroupId;
  label: string;
  hint?: string;
  options: AuthChoiceOption[];
};

const AUTH_CHOICE_GROUP_DEFS: {
  value: AuthChoiceGroupId;
  label: string;
  hint?: string;
  choices: AuthChoice[];
}[] = [
  {
    value: "openai",
    label: "OpenAI",
    hint: "Codex OAuth + API key",
    choices: ["openai-codex", "openai-api-key"],
  },
  {
    value: "anthropic",
    label: "Anthropic",
    hint: "setup-token + API key",
    choices: ["token", "apiKey"],
  },
  {
    value: "chutes",
    label: "Chutes",
    hint: "OAuth",
    choices: ["chutes"],
  },
  {
    value: "vllm",
    label: "vLLM",
    hint: "Local/self-hosted OpenAI-compatible",
    choices: ["vllm"],
  },
  {
    value: "minimax",
    label: "MiniMax",
    hint: "M2.5 (recommended)",
    choices: ["minimax-portal", "minimax-api", "minimax-api-lightning"],
  },
  {
    value: "moonshot",
    label: "Moonshot AI (Kimi K2.5)",
    hint: "Kimi K2.5 + Kimi Coding",
    choices: ["moonshot-api-key", "moonshot-api-key-cn", "kimi-code-api-key"],
  },
  {
    value: "google",
    label: "Google",
    hint: "Gemini API key + OAuth",
    choices: ["gemini-api-key", "google-antigravity", "google-gemini-cli"],
  },
  {
    value: "xai",
    label: "xAI (Grok)",
    hint: "API key",
    choices: ["xai-api-key"],
  },
  {
    value: "openrouter",
    label: "OpenRouter",
    hint: "API key",
    choices: ["openrouter-api-key"],
  },
  {
    value: "qwen",
    label: "Qwen",
    hint: "OAuth",
    choices: ["qwen-portal"],
  },
  {
    value: "zai",
    label: "Z.AI",
    hint: "GLM Coding Plan / Global / CN",
    choices: ["zai-coding-global", "zai-coding-cn", "zai-global", "zai-cn"],
  },
  {
    value: "qianfan",
    label: "Qianfan",
    hint: "API key",
    choices: ["qianfan-api-key"],
  },
  {
    value: "copilot",
    label: "Copilot",
    hint: "GitHub + local proxy",
    choices: ["github-copilot", "copilot-proxy"],
  },
  {
    value: "ai-gateway",
    label: "Vercel AI Gateway",
    hint: "API key",
    choices: ["ai-gateway-api-key"],
  },
  {
    value: "opencode-zen",
    label: "OpenCode Zen",
    hint: "API key",
    choices: ["opencode-zen"],
  },
  {
    value: "xiaomi",
    label: "Xiaomi",
    hint: "API key",
    choices: ["xiaomi-api-key"],
  },
  {
    value: "synthetic",
    label: "Synthetic",
    hint: "Anthropic-compatible (multi-model)",
    choices: ["synthetic-api-key"],
  },
  {
    value: "together",
    label: "Together AI",
    hint: "API key",
    choices: ["together-api-key"],
  },
  {
    value: "huggingface",
    label: "Hugging Face",
    hint: "Inference API (HF token)",
    choices: ["huggingface-api-key"],
  },
  {
    value: "venice",
    label: "Venice AI",
    hint: "Privacy-focused (uncensored models)",
    choices: ["venice-api-key"],
  },
  {
    value: "litellm",
    label: "LiteLLM",
    hint: "Unified LLM gateway (100+ providers)",
    choices: ["litellm-api-key"],
  },
  {
    value: "cloudflare-ai-gateway",
    label: "Cloudflare AI Gateway",
    hint: "Account ID + Gateway ID + API key",
    choices: ["cloudflare-ai-gateway-api-key"],
  },
  {
    value: "custom",
    label: "Custom Provider",
    hint: "Any OpenAI or Anthropic compatible endpoint",
    choices: ["custom-api-key"],
  },
];

const BASE_AUTH_CHOICE_OPTIONS: ReadonlyArray<AuthChoiceOption> = [
  {
    value: "token",
    label: "Anthropic token (paste setup-token)",
    hint: "run `claude setup-token` elsewhere, then paste the token here",
  },
  {
    value: "openai-codex",
    label: "OpenAI Codex (ChatGPT OAuth)",
  },
  { value: "chutes", label: "Chutes (OAuth)" },
  {
    value: "vllm",
    label: "vLLM (custom URL + model)",
    hint: "Local/self-hosted OpenAI-compatible server",
  },
  { value: "openai-api-key", label: "OpenAI API key" },
  { value: "xai-api-key", label: "xAI (Grok) API key" },
  {
    value: "qianfan-api-key",
    label: "Qianfan API key",
  },
  { value: "openrouter-api-key", label: "OpenRouter API key" },
  {
    value: "litellm-api-key",
    label: "LiteLLM API key",
    hint: "Unified gateway for 100+ LLM providers",
  },
  {
    value: "ai-gateway-api-key",
    label: "Vercel AI Gateway API key",
  },
  {
    value: "cloudflare-ai-gateway-api-key",
    label: "Cloudflare AI Gateway",
    hint: "Account ID + Gateway ID + API key",
  },
  {
    value: "moonshot-api-key",
    label: "Kimi API key (.ai)",
  },
  {
    value: "moonshot-api-key-cn",
    label: "Kimi API key (.cn)",
  },
  {
    value: "kimi-code-api-key",
    label: "Kimi Code API key (subscription)",
  },
  { value: "synthetic-api-key", label: "Synthetic API key" },
  {
    value: "venice-api-key",
    label: "Venice AI API key",
    hint: "Privacy-focused inference (uncensored models)",
  },
  {
    value: "together-api-key",
    label: "Together AI API key",
    hint: "Access to Llama, DeepSeek, Qwen, and more open models",
  },
  {
    value: "huggingface-api-key",
    label: "Hugging Face API key (HF token)",
    hint: "Inference Providers — OpenAI-compatible chat",
  },
  {
    value: "github-copilot",
    label: "GitHub Copilot (GitHub device login)",
    hint: "Uses GitHub device flow",
  },
  { value: "gemini-api-key", label: "Google Gemini API key" },
  {
    value: "google-antigravity",
    label: "Google Antigravity OAuth",
    hint: "Uses the bundled Antigravity auth plugin",
  },
  {
    value: "google-gemini-cli",
    label: "Google Gemini CLI OAuth",
    hint: "Uses the bundled Gemini CLI auth plugin",
  },
  { value: "zai-api-key", label: "Z.AI API key" },
  {
    value: "zai-coding-global",
    label: "Coding-Plan-Global",
    hint: "GLM Coding Plan Global (api.z.ai)",
  },
  {
    value: "zai-coding-cn",
    label: "Coding-Plan-CN",
    hint: "GLM Coding Plan CN (open.bigmodel.cn)",
  },
  {
    value: "zai-global",
    label: "Global",
    hint: "Z.AI Global (api.z.ai)",
  },
  {
    value: "zai-cn",
    label: "CN",
    hint: "Z.AI CN (open.bigmodel.cn)",
  },
  {
    value: "xiaomi-api-key",
    label: "Xiaomi API key",
  },
  {
    value: "minimax-portal",
    label: "MiniMax OAuth",
    hint: "Oauth plugin for MiniMax",
  },
  { value: "qwen-portal", label: "Qwen OAuth" },
  {
    value: "copilot-proxy",
    label: "Copilot Proxy (local)",
    hint: "Local proxy for VS Code Copilot models",
  },
  { value: "apiKey", label: "Anthropic API key" },
  {
    value: "opencode-zen",
    label: "OpenCode Zen (multi-model proxy)",
    hint: "Claude, GPT, Gemini via opencode.ai/zen",
  },
  { value: "minimax-api", label: "MiniMax M2.5" },
  {
    value: "minimax-api-lightning",
    label: "MiniMax M2.5 Lightning",
    hint: "Faster, higher output cost",
  },
  { value: "custom-api-key", label: "Custom Provider" },
];

export function formatAuthChoiceChoicesForCli(params?: {
  includeSkip?: boolean;
  includeLegacyAliases?: boolean;
}): string {
  const includeSkip = params?.includeSkip ?? true;
  const includeLegacyAliases = params?.includeLegacyAliases ?? false;
  const values = BASE_AUTH_CHOICE_OPTIONS.map((opt) => opt.value);

  if (includeSkip) {
    values.push("skip");
  }
  if (includeLegacyAliases) {
    values.push(...AUTH_CHOICE_LEGACY_ALIASES_FOR_CLI);
  }

  return values.join("|");
}

export function buildAuthChoiceOptions(params: {
  store: AuthProfileStore;
  includeSkip: boolean;
}): AuthChoiceOption[] {
  void params.store;
  const options: AuthChoiceOption[] = [...BASE_AUTH_CHOICE_OPTIONS];

  if (params.includeSkip) {
    options.push({ value: "skip", label: "Skip for now" });
  }

  return options;
}

export function buildAuthChoiceGroups(params: { store: AuthProfileStore; includeSkip: boolean }): {
  groups: AuthChoiceGroup[];
  skipOption?: AuthChoiceOption;
} {
  const options = buildAuthChoiceOptions({
    ...params,
    includeSkip: false,
  });
  const optionByValue = new Map<AuthChoice, AuthChoiceOption>(
    options.map((opt) => [opt.value, opt]),
  );

  const groups = AUTH_CHOICE_GROUP_DEFS.map((group) => ({
    ...group,
    options: group.choices
      .map((choice) => optionByValue.get(choice))
      .filter((opt): opt is AuthChoiceOption => Boolean(opt)),
  }));

  const skipOption = params.includeSkip
    ? ({ value: "skip", label: "Skip for now" } satisfies AuthChoiceOption)
    : undefined;

  return { groups, skipOption };
}

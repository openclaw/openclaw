export const PROVIDER_ENV_VARS: Record<string, readonly string[]> = {
  openai: ["OPENAI_API_KEY"],
  anthropic: ["ANTHROPIC_API_KEY"],
  google: ["GEMINI_API_KEY"],
  minimax: ["MINIMAX_API_KEY"],
  "minimax-cn": ["MINIMAX_API_KEY"],
  moonshot: ["MOONSHOT_API_KEY"],
  "kimi-coding": ["KIMI_API_KEY", "KIMICODE_API_KEY"],
  synthetic: ["SYNTHETIC_API_KEY"],
  venice: ["VENICE_API_KEY"],
  zai: ["ZAI_API_KEY", "Z_AI_API_KEY"],
  xiaomi: ["XIAOMI_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY"],
  "cloudflare-ai-gateway": ["CLOUDFLARE_AI_GATEWAY_API_KEY"],
  litellm: ["LITELLM_API_KEY"],
  "vercel-ai-gateway": ["AI_GATEWAY_API_KEY"],
  opencode: ["OPENCODE_API_KEY", "OPENCODE_ZEN_API_KEY"],
  together: ["TOGETHER_API_KEY"],
  huggingface: ["HUGGINGFACE_HUB_TOKEN", "HF_TOKEN"],
  qianfan: ["QIANFAN_API_KEY"],
  xai: ["XAI_API_KEY"],
  volcengine: ["VOLCANO_ENGINE_API_KEY"],
  byteplus: ["BYTEPLUS_API_KEY"],
};

export function listKnownSecretEnvVarNames(): string[] {
  return [...new Set(Object.values(PROVIDER_ENV_VARS).flatMap((keys) => keys))];
}

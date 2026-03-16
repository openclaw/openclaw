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
  mistral: ["MISTRAL_API_KEY"],
  kilocode: ["KILOCODE_API_KEY"],
  volcengine: ["VOLCANO_ENGINE_API_KEY"],
  byteplus: ["BYTEPLUS_API_KEY"],
};

const EXTRA_PROVIDER_AUTH_ENV_VARS = [
  "VOYAGE_API_KEY",
  "GROQ_API_KEY",
  "DEEPGRAM_API_KEY",
  "CEREBRAS_API_KEY",
  "NVIDIA_API_KEY",
  "COPILOT_GITHUB_TOKEN",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "ANTHROPIC_OAUTH_TOKEN",
  "CHUTES_OAUTH_TOKEN",
  "CHUTES_API_KEY",
  "QWEN_OAUTH_TOKEN",
  "QWEN_PORTAL_API_KEY",
  "MINIMAX_OAUTH_TOKEN",
  "OLLAMA_API_KEY",
  "VLLM_API_KEY",
] as const;

const KNOWN_SECRET_ENV_VARS = [
  ...new Set(Object.values(PROVIDER_ENV_VARS).flatMap((keys) => keys)),
];

// OPENCLAW_API_KEY authenticates the local OpenClaw bridge itself and must
// remain available to child bridge/runtime processes.
const KNOWN_PROVIDER_AUTH_ENV_VARS = [
  ...new Set([...KNOWN_SECRET_ENV_VARS, ...EXTRA_PROVIDER_AUTH_ENV_VARS]),
];

export function listKnownProviderAuthEnvVarNames(): string[] {
  return [...KNOWN_PROVIDER_AUTH_ENV_VARS];
}

export function listKnownSecretEnvVarNames(): string[] {
  return [...KNOWN_SECRET_ENV_VARS];
}

export function omitEnvKeysCaseInsensitive(
  baseEnv: NodeJS.ProcessEnv,
  keys: Iterable<string>,
): NodeJS.ProcessEnv {
  const env = { ...baseEnv };
  const denied = new Set<string>();
  for (const key of keys) {
    const normalizedKey = key.trim();
    if (normalizedKey) {
      denied.add(normalizedKey.toUpperCase());
    }
  }
  if (denied.size === 0) {
    return env;
  }
  for (const actualKey of Object.keys(env)) {
    if (denied.has(actualKey.toUpperCase())) {
      delete env[actualKey];
    }
  }
  return env;
}

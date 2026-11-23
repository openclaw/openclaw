import { takeGraphemes } from "../lib/graphemes.ts";

const PROVIDER_ICON_NAMES = new Set([
  "abacus",
  "abliteration",
  "alibaba",
  "amp",
  "antigravity",
  "arcee",
  "augment",
  "baseten",
  "bedrock",
  "byteplus",
  "cerebras",
  "chutes",
  "claude",
  "clawrouter",
  "cloudflare",
  "codebuff",
  "codex",
  "cohere",
  "comfy",
  "commandcode",
  "copilot",
  "crof",
  "crossmodel",
  "cursor",
  "deepgram",
  "deepinfra",
  "deepseek",
  "devin",
  "doubao",
  "elevenlabs",
  "factory",
  "fal",
  "featherless",
  "fireworks",
  "gemini",
  "grok",
  "groq",
  "huggingface",
  "jetbrains",
  "kilo",
  "kimi",
  "kiro",
  "litellm",
  "llamacpp",
  "llmproxy",
  "lmstudio",
  "longcat",
  "manus",
  "meta",
  "microsoft",
  "mimo",
  "minimax",
  "mistral",
  "novita",
  "nvidia",
  "ollama",
  "opencode",
  "opencodego",
  "openrouter",
  "particle",
  "perplexity",
  "pi",
  "pixverse",
  "poe",
  "qianfan",
  "qoder",
  "requesty",
  "runway",
  "sakana",
  "stepfun",
  "synthetic",
  "t3chat",
  "tencent",
  "together",
  "venice",
  "vercel",
  "vertexai",
  "vllm",
  "volcengine",
  "warp",
  "windsurf",
  "zai",
  "zed",
]);

// Canonical provider id → icon asset name for providers whose brand mark ships
// under a different slug than their catalog id.
const PROVIDER_ICON_ALIASES: Readonly<Record<string, string>> = {
  anthropic: "claude",
  "amazon-bedrock": "bedrock",
  "aws-bedrock": "bedrock",
  "claude-cli": "claude",
  "cloudflare-ai-gateway": "cloudflare",
  "copilot-proxy": "copilot",
  google: "gemini",
  "google-gemini-cli": "gemini",
  "github-copilot": "copilot",
  kilocode: "kilo",
  "kimi-coding": "kimi",
  "llama-cpp": "llamacpp",
  "microsoft-foundry": "microsoft",
  "minimax-portal": "minimax",
  "ollama-cloud": "ollama",
  // CodexBar names its bundled OpenAI knot asset "codex".
  openai: "codex",
  moonshot: "kimi",
  "opencode-go": "opencodego",
  "opencode-zen": "opencode",
  qwen: "alibaba",
  "qwen-token-plan": "alibaba",
  "stepfun-plan": "stepfun",
  "tencent-tokenhub": "tencent",
  "tencent-tokenplan": "tencent",
  xai: "grok",
  // Xiaomi ships its AI models under the MiMo brand mark.
  xiaomi: "mimo",
  "xiaomi-token-plan": "mimo",
  "vercel-ai-gateway": "vercel",
  "vertex-ai": "vertexai",
  "z-ai": "zai",
};

// Brand display names for provider ids whose title-cased id reads wrong.
const PROVIDER_DISPLAY_LABELS: Readonly<Record<string, string>> = {
  "acp-copilot": "GitHub Copilot CLI",
  "acp-kilocode": "Kilo Code (ACP)",
  "acp-qwen": "Qwen Code (ACP)",
  anthropic: "Anthropic",
  byteplus: "BytePlus",
  "byteplus-plan": "BytePlus Plan",
  "claude-cli": "Claude CLI",
  clawrouter: "ClawRouter",
  deepinfra: "DeepInfra",
  deepseek: "DeepSeek",
  fal: "fal",
  "github-copilot": "GitHub Copilot",
  google: "Google",
  "google-gemini-cli": "Gemini CLI",
  "google-vertex": "Google Vertex AI",
  huggingface: "Hugging Face",
  kie: "Kie AI",
  "liquid-ai": "Liquid AI",
  litellm: "LiteLLM",
  "llama-cpp": "llama.cpp",
  lmstudio: "LM Studio",
  longcat: "LongCat",
  minimax: "MiniMax",
  "minimax-portal": "MiniMax Portal",
  moonshot: "Moonshot AI",
  novita: "NovitaAI",
  nvidia: "NVIDIA",
  onnx: "ONNX",
  openai: "OpenAI",
  opencode: "OpenCode",
  "opencode-go": "OpenCode Go",
  openrouter: "OpenRouter",
  qwen: "Qwen Cloud",
  sglang: "SGLang",
  "tencent-tokenhub": "Tencent TokenHub",
  "tencent-tokenplan": "Tencent TokenPlan",
  typesafe: "TypeSafe AI",
  vllm: "vLLM",
  xai: "xAI",
  zai: "Z.AI",
};

// ACPX native harnesses publish their catalogs under `acp-<agent>` provider ids.
const ACP_HARNESS_PROVIDER = /^acp-(.+)$/u;

/** Title-cased fallback label built from the provider id ("z-ai" → "Z Ai"). */
export function formatRawProviderLabel(provider: string): string {
  return provider
    .split(/[-_]+/u)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

/** Brand display name for a (normalized, lowercase) provider id. */
export type ProviderPresentation = {
  providerName?: string;
  providerIcon?: { source: "builtin"; name: string } | { source: "asset"; url: string };
};

export function providerDisplayLabel(
  provider: string,
  presentation?: Pick<ProviderPresentation, "providerName">,
): string {
  if (presentation?.providerName) {
    return presentation.providerName;
  }
  if (Object.hasOwn(PROVIDER_DISPLAY_LABELS, provider)) {
    return PROVIDER_DISPLAY_LABELS[provider]!;
  }
  const acpAgent = ACP_HARNESS_PROVIDER.exec(provider)?.[1];
  return acpAgent ? `${providerDisplayLabel(acpAgent)} (ACP)` : formatRawProviderLabel(provider);
}

/** Provider id from a canonical `provider/model` reference, or null when absent. */
export function providerIdFromModelRef(modelRef: string): string | null {
  const separator = modelRef.indexOf("/");
  const provider = separator > 0 ? modelRef.slice(0, separator).trim().toLowerCase() : "";
  return provider || null;
}

/** Icon asset name for a (normalized, lowercase) provider id, or null when no brand mark ships. */
export function resolveProviderIconName(provider: string): string | null {
  const normalized = provider.trim().toLowerCase();
  const icon = PROVIDER_ICON_ALIASES[normalized] ?? normalized;
  if (PROVIDER_ICON_NAMES.has(icon)) {
    return icon;
  }
  const acpAgent = ACP_HARNESS_PROVIDER.exec(normalized)?.[1];
  return acpAgent ? resolveProviderIconName(acpAgent) : null;
}

export function hasProviderBrandIcon(provider: string): boolean {
  return resolveProviderIconName(provider) !== null;
}

export function providerFallbackLetter(label: string): string {
  return takeGraphemes(label.trim().toUpperCase(), 1) || "?";
}

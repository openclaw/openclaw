// Icon assets live in ui/public/provider-icons/ProviderIcon-<name>.svg;
// shared styles live under .provider-brand-icon in styles/components.css.
import { html } from "lit";
import { inferControlUiPublicAssetPath } from "../app/public-assets.ts";
import { takeGraphemes } from "../lib/graphemes.ts";
import { icons } from "./icons.ts";

const PROVIDER_ICON_NAMES = new Set([
  "abacus",
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
  "perplexity",
  "pi",
  "pixverse",
  "poe",
  "qianfan",
  "qoder",
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
  "claude-cli": "Claude CLI",
  google: "Google",
  "github-copilot": "GitHub",
  "llama-cpp": "llama.cpp",
  lmstudio: "LM Studio",
  longcat: "LongCat",
  openai: "OpenAI",
  moonshot: "Moonshot AI",
  opencode: "OpenCode",
  openrouter: "OpenRouter",
  qwen: "Qwen Cloud",
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
export function providerDisplayLabel(provider: string): string {
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
function resolveProviderIconName(provider: string): string | null {
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

type CloudProfileIdentity = { providerId: string; providerDisplayId?: string };

// Cloud backends are a separate identity domain: Google Cloud is not Gemini,
// and AWS is not Bedrock. Map lookup also keeps prototype keys on the fallback.
const CLOUD_PROVIDERS = new Map<string, { label: string; brand?: string }>([
  ["aws", { label: "AWS", brand: "aws" }],
  ["azure", { label: "Azure", brand: "azure" }],
  ["daytona", { label: "Daytona", brand: "daytona" }],
  ["gcp", { label: "Google Cloud", brand: "gcp" }],
  ["hetzner", { label: "Hetzner", brand: "hetzner" }],
  ["machine0", { label: "Machine0" }],
]);
const CLOUD_ALIASES = new Map([
  ["google", "gcp"],
  ["google-cloud", "gcp"],
  ["docker", "local-container"],
  ["local-docker", "local-container"],
  ["podman", "local-container"],
  ["local-podman", "local-container"],
]);

function cloudProfileBackendId(profile?: CloudProfileIdentity): string {
  const raw = (profile?.providerDisplayId ?? profile?.providerId ?? "").trim().toLowerCase();
  return CLOUD_ALIASES.get(raw) ?? raw;
}

/** Known cloud services precede local/custom infrastructure, alphabetically within each group. */
export function compareCloudProfiles(
  left: CloudProfileIdentity & { id: string },
  right: CloudProfileIdentity & { id: string },
): number {
  // Backend identity, not an editable profile name or the availability of a logo.
  return (
    Number(CLOUD_PROVIDERS.has(cloudProfileBackendId(right))) -
      Number(CLOUD_PROVIDERS.has(cloudProfileBackendId(left))) || left.id.localeCompare(right.id)
  );
}

/** One presentation resolver for cloud triggers, menus, and move-session rows. */
export function resolveCloudProfileIcon(profile?: CloudProfileIdentity) {
  const id = cloudProfileBackendId(profile);
  const brand = CLOUD_PROVIDERS.get(id);
  const label =
    brand?.label ?? (profile?.providerDisplayId ?? profile?.providerId ?? "").trim().toLowerCase();
  const icon = brand?.brand
    ? renderBrandIcon(
        inferControlUiPublicAssetPath(`cloud-provider-icons/${brand.brand}.svg`),
        brand.brand,
        "cloud-provider-icon",
      )
    : id === "machine0" || id === "incus"
      ? icons.server
      : id === "local-container"
        ? icons.box
        : icons.cloud;
  return {
    label,
    icon: html`<span class="cloud-profile-icon" aria-hidden="true">${icon}</span>`,
  };
}

function renderBrandIcon(assetPath: string, icon: string, className = "") {
  return html`<span
    class="provider-brand-icon ${className}"
    data-provider-icon=${icon}
    style=${`--provider-icon-url: url("${assetPath}")`}
    aria-hidden="true"
  ></span>`;
}

/** Lettered badge for surfaces that must not infer a provider identity. */
export function renderProviderFallbackIcon(label: string, options?: { className?: string }) {
  const surfaceClass = options?.className ? ` ${options.className}` : "";
  const letter = takeGraphemes(label.trim().toUpperCase(), 1) || "?";
  return html`
    <span
      class="provider-brand-icon provider-brand-icon--fallback${surfaceClass}"
      aria-hidden="true"
    >
      ${letter}
    </span>
  `;
}

export function renderProviderBrandIcon(provider: string, options?: { className?: string }) {
  const icon = resolveProviderIconName(provider);
  if (!icon) {
    return renderProviderFallbackIcon(provider, options);
  }
  return renderBrandIcon(
    inferControlUiPublicAssetPath(`provider-icons/ProviderIcon-${icon}.svg`),
    icon,
    options?.className?.trim() ?? "",
  );
}

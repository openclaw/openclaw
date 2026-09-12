/** Input contracts shared by manual token/API-key commands and the API-key writer. */
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { formatCliCommand } from "../../cli/command-format.js";

export function resolveDefaultTokenProfileId(provider: string): string {
  return `${normalizeProviderId(provider)}:manual`;
}

export function normalizeManualAuthProvider(provider: string): string {
  const normalized = normalizeProviderId(provider);
  if (normalized === "openai-codex" || normalized === "codex-cli") {
    throw new Error(`"${normalized}" is a legacy provider ID; use --provider openai.`);
  }
  return normalized === "openai" || normalized === "codex" ? "openai" : normalized;
}

function stripBearerPrefix(value: string): string {
  return value
    .trim()
    .replace(/^Bearer\s+/i, "")
    .trim();
}

export function looksLikeOpenAIApiKey(value: string): boolean {
  return /^sk-[A-Za-z0-9_-]{8,}$/.test(value.trim());
}

function looksLikeJwtToken(value: string): boolean {
  const token = stripBearerPrefix(value);
  const parts = token.split(".");
  return parts.length === 3 && parts.every((part) => /^[A-Za-z0-9_-]{8,}$/.test(part));
}

function looksLikeStructuredCredential(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.startsWith("{") || trimmed.startsWith("[");
}

export function validateOpenAICodexApiKeyInput(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return "Required";
  }
  if (looksLikeOpenAIApiKey(trimmed)) {
    return undefined;
  }
  if (looksLikeJwtToken(trimmed) || looksLikeStructuredCredential(trimmed)) {
    // OAuth/token material belongs in token profiles; storing it as an API key
    // would make provider auth fail later with misleading model errors.
    return `That looks like token or OAuth material, not an OpenAI API key. Use ${formatCliCommand("openclaw models auth paste-token --provider openai")} for token auth material.`;
  }
  return "That does not look like an OpenAI API key.";
}

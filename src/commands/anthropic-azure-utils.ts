import { URL } from "node:url";
import type { ModelDefinitionConfig } from "../config/types.models.js";

export const ANTHROPIC_AZURE_HOST_SUFFIX = ".services.ai.azure.com";
export const ANTHROPIC_AZURE_API_SUFFIX = "/anthropic";

export const DEFAULT_ANTHROPIC_AZURE_MODEL_ID = "claude-sonnet-4-6";

export const ANTHROPIC_AZURE_MODEL_CHOICES = [
  { value: "claude-sonnet-4-6", label: "Claude Sonnet 4.6 (default)" },
  { value: "claude-opus-4-6", label: "Claude Opus 4.6" },
] as const;

const ANTHROPIC_AZURE_DEFAULT_CONTEXT_WINDOW = 200_000;
const ANTHROPIC_AZURE_DEFAULT_MAX_TOKENS = 16_384;
const ANTHROPIC_AZURE_DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

export function buildAnthropicAzureModelDefinition(params: {
  id: string;
  label?: string;
}): ModelDefinitionConfig {
  return {
    id: params.id,
    name: params.label ?? params.id,
    reasoning: true,
    input: ["text", "image"],
    cost: ANTHROPIC_AZURE_DEFAULT_COST,
    contextWindow: ANTHROPIC_AZURE_DEFAULT_CONTEXT_WINDOW,
    maxTokens: ANTHROPIC_AZURE_DEFAULT_MAX_TOKENS,
  };
}

function ensureHttpsUrl(candidate: string): URL {
  try {
    return new URL(candidate);
  } catch (error) {
    throw new Error(`Invalid Azure Claude URL: ${String(error)}`, { cause: error });
  }
}

export function normalizeAnthropicAzureBaseUrl(resourceOrUrl: string): string {
  const raw = String(resourceOrUrl ?? "").trim();
  if (!raw) {
    throw new Error("Azure Claude resource name or URL is required.");
  }
  if (/^https?:\/\//i.test(raw)) {
    const url = ensureHttpsUrl(raw);
    if (!url.hostname.toLowerCase().endsWith(ANTHROPIC_AZURE_HOST_SUFFIX)) {
      throw new Error(
        `Azure Claude endpoint host must end with "${ANTHROPIC_AZURE_HOST_SUFFIX}". Received ${url.hostname}.`,
      );
    }
    const normalizedHost = url.hostname.toLowerCase();
    const basePath = url.pathname.replace(/\/+$/, "");
    const normalizedPath = basePath.endsWith(ANTHROPIC_AZURE_API_SUFFIX)
      ? basePath
      : `${basePath}${ANTHROPIC_AZURE_API_SUFFIX}`;
    const finalPath = normalizedPath || ANTHROPIC_AZURE_API_SUFFIX;
    return `https://${normalizedHost}${finalPath}`;
  }
  const normalizedResource = raw.toLowerCase().replace(/[^a-z0-9-]/g, "");
  if (!normalizedResource) {
    throw new Error("Azure Claude resource name must contain alphanumeric characters or hyphens.");
  }
  return `https://${normalizedResource}${ANTHROPIC_AZURE_HOST_SUFFIX}${ANTHROPIC_AZURE_API_SUFFIX}`;
}

export function resolveAnthropicAzureResourceName(
  baseUrl: string | null | undefined,
): string | undefined {
  if (!baseUrl) {
    return undefined;
  }
  try {
    const url = ensureHttpsUrl(baseUrl);
    const host = url.hostname.toLowerCase();
    if (!host.endsWith(ANTHROPIC_AZURE_HOST_SUFFIX)) {
      return undefined;
    }
    const resource = host.slice(0, -ANTHROPIC_AZURE_HOST_SUFFIX.length);
    return resource || undefined;
  } catch {
    return undefined;
  }
}

export function resolveAnthropicAzureBaseUrlFromEnv(env: NodeJS.ProcessEnv): string | undefined {
  const baseUrlCandidates = [env.ANTHROPIC_FOUNDRY_BASE_URL, env.AZURE_CLAUDE_BASE_URL];
  for (const candidate of baseUrlCandidates) {
    if (candidate && candidate.trim()) {
      try {
        return normalizeAnthropicAzureBaseUrl(candidate);
      } catch {
        // fall through to resources if URL invalid
      }
    }
  }
  const resourceCandidates = [env.ANTHROPIC_FOUNDRY_RESOURCE, env.AZURE_CLAUDE_RESOURCE];
  for (const candidate of resourceCandidates) {
    if (candidate && candidate.trim()) {
      try {
        return normalizeAnthropicAzureBaseUrl(candidate);
      } catch {
        // ignore invalid resources, try next
      }
    }
  }
  return undefined;
}

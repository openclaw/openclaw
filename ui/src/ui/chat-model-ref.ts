import type { ModelCatalogEntry } from "./types.ts";

export type ChatModelOverride =
  | {
      kind: "qualified";
      value: string;
    }
  | {
      kind: "raw";
      value: string;
    };

export function buildQualifiedChatModelValue(model: string, provider?: string | null): string {
  const trimmedModel = model.trim();
  if (!trimmedModel) {
    return "";
  }
  const trimmedProvider = provider?.trim();
  return trimmedProvider ? `${trimmedProvider}/${trimmedModel}` : trimmedModel;
}

export function createChatModelOverride(value: string): ChatModelOverride | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.includes("/")) {
    return { kind: "qualified", value: trimmed };
  }
  return { kind: "raw", value: trimmed };
}

export function normalizeChatModelOverrideValue(
  override: ChatModelOverride | null | undefined,
  catalog: ModelCatalogEntry[],
): string {
  if (!override) {
    return "";
  }
  const trimmed = override?.value.trim();
  if (!trimmed) {
    return "";
  }
  if (override.kind === "qualified") {
    return trimmed;
  }

  let matchedValue = "";
  for (const entry of catalog) {
    if (entry.id.trim().toLowerCase() !== trimmed.toLowerCase()) {
      continue;
    }
    const candidate = buildQualifiedChatModelValue(entry.id, entry.provider);
    if (!matchedValue) {
      matchedValue = candidate;
      continue;
    }
    if (matchedValue.toLowerCase() !== candidate.toLowerCase()) {
      return trimmed;
    }
  }
  return matchedValue || trimmed;
}

export function resolveServerChatModelValue(
  model?: string | null,
  provider?: string | null,
): string {
  if (typeof model !== "string") {
    return "";
  }
  return buildQualifiedChatModelValue(model, provider);
}

export function formatChatModelDisplay(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  const separator = trimmed.indexOf("/");
  if (separator <= 0) {
    return trimmed;
  }
  return `${trimmed.slice(separator + 1)} · ${trimmed.slice(0, separator)}`;
}

export function buildChatModelOption(entry: ModelCatalogEntry): { value: string; label: string } {
  const provider = entry.provider?.trim();
  return {
    value: buildQualifiedChatModelValue(entry.id, provider),
    label: provider ? `${entry.id} · ${provider}` : entry.id,
  };
}

/**
 * Local proxy providers that should be deprioritized when the same model ID
 * appears under multiple providers. A real provider (anthropic, openai, etc.)
 * is always preferred over a local proxy (ollama, vllm, sglang).
 */
const LOCAL_PROXY_PROVIDERS = new Set(["ollama", "vllm", "sglang", "local"]);

function isLocalProxy(provider: string): boolean {
  return LOCAL_PROXY_PROVIDERS.has(provider.trim().toLowerCase());
}

/**
 * For a given model ID, return entries that should be deduplicated.
 * Only deduplicates when there's a mix of local proxies and real providers
 * (keep real, drop proxies). When all providers are real, returns all of them.
 */
export function getDeduplicatedProviders(
  entries: ModelCatalogEntry[],
  modelId: string,
): ModelCatalogEntry[] {
  const normalizedId = modelId.trim().toLowerCase();
  const matches = entries.filter(
    (e) => e.id.trim().toLowerCase() === normalizedId,
  );
  if (matches.length <= 1) return matches;

  const nonProxy = matches.filter((e) => !isLocalProxy(e.provider ?? ""));
  const proxies = matches.filter((e) => isLocalProxy(e.provider ?? ""));

  // If there's at least one real provider, drop all proxies
  if (nonProxy.length >= 1) return nonProxy;

  // All are proxies — keep them all (edge case, but let user choose)
  return matches;
}

import { normalizeProviderId } from "../../agents/model-selection.js";
import type { ClawdbotConfig } from "../../config/config.js";

export type ModelPickerCatalogEntry = {
  provider: string;
  id: string;
  name?: string;
};

export type ModelPickerItem = {
  model: string;
  provider: string;
  /** @deprecated Use provider instead - kept for compatibility during transition */
  providers: string[];
  /** @deprecated Use provider/model instead - kept for compatibility during transition */
  providerModels: Record<string, string>;
};

const MODEL_PICK_PROVIDER_PREFERENCE = [
  "anthropic",
  "openai",
  "openai-codex",
  "minimax",
  "synthetic",
  "google",
  "zai",
  "openrouter",
  "opencode",
  "github-copilot",
  "groq",
  "cerebras",
  "mistral",
  "xai",
  "lmstudio",
] as const;

function normalizeModelFamilyId(id: string): string {
  const trimmed = id.trim();
  if (!trimmed) return trimmed;
  const parts = trimmed.split("/").filter(Boolean);
  return parts.length > 0 ? (parts[parts.length - 1] ?? trimmed) : trimmed;
}

function sortProvidersForPicker(providers: string[]): string[] {
  const pref = new Map<string, number>(
    MODEL_PICK_PROVIDER_PREFERENCE.map((provider, idx) => [provider, idx]),
  );
  return providers.sort((a, b) => {
    const pa = pref.get(a);
    const pb = pref.get(b);
    if (pa !== undefined && pb !== undefined) return pa - pb;
    if (pa !== undefined) return -1;
    if (pb !== undefined) return 1;
    return a.localeCompare(b);
  });
}

export function buildModelPickerItems(catalog: ModelPickerCatalogEntry[]): ModelPickerItem[] {
  const seen = new Set<string>();
  const out: ModelPickerItem[] = [];

  for (const entry of catalog) {
    const provider = normalizeProviderId(entry.provider);
    const model = entry.id?.trim();
    if (!provider || !model) continue;

    const key = `${provider}/${model}`;
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({
      model,
      provider,
      // Deprecated fields kept for compatibility
      providers: [provider],
      providerModels: { [provider]: model },
    });
  }

  // Sort by provider preference first, then by model name
  out.sort((a, b) => {
    const providerOrder = sortProvidersForPicker([a.provider, b.provider]);
    if (providerOrder[0] !== a.provider) return 1;
    if (providerOrder[0] !== b.provider) return -1;
    return a.model.toLowerCase().localeCompare(b.model.toLowerCase());
  });

  return out;
}

export function pickProviderForModel(params: {
  item: ModelPickerItem;
  preferredProvider?: string;
}): { provider: string; model: string } | null {
  // Each item now has exactly one provider, so just return it directly
  if (!params.item.provider) return null;
  return {
    provider: params.item.provider,
    model: params.item.model,
  };
}

export function resolveProviderEndpointLabel(
  provider: string,
  cfg: ClawdbotConfig,
): { endpoint?: string; api?: string } {
  const normalized = normalizeProviderId(provider);
  const providers = (cfg.models?.providers ?? {}) as Record<
    string,
    { baseUrl?: string; api?: string } | undefined
  >;
  const entry = providers[normalized];
  const endpoint = entry?.baseUrl?.trim();
  const api = entry?.api?.trim();
  return {
    endpoint: endpoint || undefined,
    api: api || undefined,
  };
}

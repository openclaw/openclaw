import { normalizeProviderId } from "../../agents/model-selection.js";
import type { ClawdbotConfig } from "../../config/config.js";

export type ModelPickerCatalogEntry = {
  provider: string;
  id: string;
  name?: string;
};

export type ModelPickerItem = {
  model: string;
  providers: string[];
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

export function buildModelPickerItems(
  catalog: ModelPickerCatalogEntry[],
): ModelPickerItem[] {
  const byModel = new Map<string, { providerModels: Record<string, string> }>();
  for (const entry of catalog) {
    const provider = normalizeProviderId(entry.provider);
    const model = normalizeModelFamilyId(entry.id);
    if (!provider || !model) continue;
    const existing = byModel.get(model);
    if (existing) {
      existing.providerModels[provider] = entry.id;
      continue;
    }
    byModel.set(model, { providerModels: { [provider]: entry.id } });
  }
  const out: ModelPickerItem[] = [];
  for (const [model, data] of byModel.entries()) {
    const providers = sortProvidersForPicker(Object.keys(data.providerModels));
    out.push({ model, providers, providerModels: data.providerModels });
  }
  out.sort((a, b) =>
    a.model.toLowerCase().localeCompare(b.model.toLowerCase()),
  );
  return out;
}

export function pickProviderForModel(params: {
  item: ModelPickerItem;
  preferredProvider?: string;
}): { provider: string; model: string } | null {
  const preferred = params.preferredProvider
    ? normalizeProviderId(params.preferredProvider)
    : undefined;
  if (preferred && params.item.providerModels[preferred]) {
    return {
      provider: preferred,
      model: params.item.providerModels[preferred],
    };
  }
  const first = params.item.providers[0];
  if (!first) return null;
  return {
    provider: first,
    model: params.item.providerModels[first] ?? params.item.model,
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

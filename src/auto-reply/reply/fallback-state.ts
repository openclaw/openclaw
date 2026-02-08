import { normalizeProviderId } from "../../agents/model-selection.js";

function normalizeModelId(provider: string, model: string): string {
  const trimmed = String(model ?? "").trim();
  if (!trimmed) {
    return "";
  }
  const normalizedProvider = normalizeProviderId(provider);
  const lower = trimmed.toLowerCase();
  const providerPrefix = `${normalizedProvider}/`;
  if (lower.startsWith(providerPrefix)) {
    return trimmed.slice(providerPrefix.length).trim();
  }
  return trimmed;
}

export function isFallbackModelActive(params: {
  provider: string;
  model: string;
  defaultProvider: string;
  defaultModel: string;
}): boolean {
  const provider = normalizeProviderId(params.provider);
  const defaultProvider = normalizeProviderId(params.defaultProvider);
  const model = normalizeModelId(provider, params.model);
  const defaultModel = normalizeModelId(defaultProvider, params.defaultModel);
  return provider !== defaultProvider || model !== defaultModel;
}

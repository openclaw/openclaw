import { normalizeProviderId } from "../agents/provider-id.js";
import { getPluginRegistryState } from "./runtime-state.js";
const BUNDLED_SYNTHETIC_AUTH_PROVIDER_REFS = ["claude-cli", "ollama", "xai"] as const;

function uniqueProviderRefs(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const next: string[] = [];
  for (const raw of values) {
    const trimmed = raw.trim();
    const normalized = normalizeProviderId(trimmed);
    if (!trimmed || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    next.push(trimmed);
  }
  return next;
}

export function resolveRuntimeSyntheticAuthProviderRefs(): string[] {
  const registry = getPluginRegistryState()?.activeRegistry;
  if (registry) {
    return uniqueProviderRefs([
      ...(registry.providers ?? [])
        .filter(
          (entry) =>
            "resolveSyntheticAuth" in entry.provider &&
            typeof entry.provider.resolveSyntheticAuth === "function",
        )
        .map((entry) => entry.provider.id),
      ...(registry.cliBackends ?? [])
        .filter(
          (entry) =>
            "resolveSyntheticAuth" in entry.backend &&
            typeof entry.backend.resolveSyntheticAuth === "function",
        )
        .map((entry) => entry.backend.id),
    ]);
  }
  return uniqueProviderRefs(BUNDLED_SYNTHETIC_AUTH_PROVIDER_REFS);
}

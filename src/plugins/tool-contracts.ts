import type { PluginManifestContracts } from "./manifest.js";
import { compileGlobPatterns, matchesAnyGlobPattern } from "../agents/glob-pattern.js";

export function normalizePluginToolContractNames(
  contracts: Pick<PluginManifestContracts, "tools"> | undefined,
): string[] {
  return normalizePluginToolNames(contracts?.tools);
}

export function normalizePluginToolNames(names: readonly string[] | undefined): string[] {
  const normalized = new Set<string>();
  for (const name of names ?? []) {
    const trimmed = name.trim();
    if (trimmed) {
      normalized.add(trimmed);
    }
  }
  return [...normalized];
}

export function findUndeclaredPluginToolNames(params: {
  declaredNames: readonly string[];
  toolNames: readonly string[];
}): string[] {
  const declared = new Set(normalizePluginToolNames(params.declaredNames));
  const compiledGlobPatterns = compileGlobPatterns({
    raw: params.declaredNames,
    normalize: (v: string) => v.toLowerCase().trim(),
  });
  return normalizePluginToolNames(params.toolNames).filter((name) =>
    !declared.has(name) && !matchesAnyGlobPattern(name, compiledGlobPatterns)
  );
}

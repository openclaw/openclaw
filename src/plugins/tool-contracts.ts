import type { PluginManifestContracts } from "./manifest.js";

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

export function isPluginToolContractPattern(name: string): boolean {
  const trimmed = name.trim();
  return trimmed.length > 1 && trimmed.endsWith("*") && trimmed.indexOf("*") === trimmed.length - 1;
}

export function pluginToolContractMatchesName(params: {
  contractName: string;
  toolName: string;
}): boolean {
  const contractName = params.contractName.trim();
  const toolName = params.toolName.trim();
  if (!contractName || !toolName) {
    return false;
  }
  if (!isPluginToolContractPattern(contractName)) {
    return contractName === toolName;
  }
  return toolName.startsWith(contractName.slice(0, -1));
}

export function pluginToolContractMatchesAnyName(params: {
  contractName: string;
  toolNames: readonly string[];
}): boolean {
  return normalizePluginToolNames(params.toolNames).some((toolName) =>
    pluginToolContractMatchesName({ contractName: params.contractName, toolName }),
  );
}

export function findUndeclaredPluginToolNames(params: {
  declaredNames: readonly string[];
  toolNames: readonly string[];
}): string[] {
  const declared = normalizePluginToolNames(params.declaredNames);
  return normalizePluginToolNames(params.toolNames).filter(
    (name) =>
      !declared.some((contractName) =>
        pluginToolContractMatchesName({ contractName, toolName: name }),
      ),
  );
}

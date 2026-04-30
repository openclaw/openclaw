import type { PluginInstallRecord } from "../config/types.plugins.js";
import { parseRegistryNpmSpec } from "../infra/npm-registry-spec.js";

export function extractInstalledNpmPackageName(install: PluginInstallRecord): string | undefined {
  if (install.source !== "npm") {
    return undefined;
  }
  const resolvedName = install.resolvedName?.trim();
  if (resolvedName) {
    return resolvedName;
  }
  return (
    (install.spec ? parseRegistryNpmSpec(install.spec)?.name : undefined) ??
    (install.resolvedSpec ? parseRegistryNpmSpec(install.resolvedSpec)?.name : undefined)
  );
}

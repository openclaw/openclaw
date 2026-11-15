import { getRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { RepositoryIntegration } from "./repository-integration.types.js";
import { getPluginRegistryForContext, getActivePluginRegistry } from "./runtime.js";

/** Explicit required ownership survives missing manifests and failed plugin registration. */
export function getRepositoryIntegration(
  config?: OpenClawConfig,
): RepositoryIntegration | undefined {
  // Scoped/captured config cannot remove a requirement published by the runtime.
  const id = (getRuntimeConfigSnapshot() ?? config)?.gateway?.repositoryIntegration;
  if (!id) {
    return undefined;
  }
  const registry = getPluginRegistryForContext() ?? getActivePluginRegistry();
  const owners = registry?.plugins.filter((record) => record.id === id) ?? [];
  if (owners.length !== 1) {
    throw new Error(`Required repository integration "${id}" is unavailable`);
  }
  const owner = owners[0]!;
  const entries = registry!.repositoryIntegrations.filter((entry) => entry.pluginId === id);
  if (
    !owner.enabled ||
    owner.status !== "loaded" ||
    !owner.contracts?.repositoryIntegrations?.includes("repository") ||
    entries.length !== 1
  ) {
    throw new Error(`Required repository integration "${id}" is unavailable`);
  }
  entries[0]!.assertCurrent();
  return entries[0]!.integration;
}

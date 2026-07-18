// Model picker provider choices projected from the lifecycle-owned catalog.
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { resolveDefaultAgentDir } from "../agents/agent-scope.js";
import type { ModelCatalogEntry } from "../agents/model-catalog.js";
import { loadPreparedModelCatalog } from "../agents/prepared-model-catalog.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

/** Loads committed catalog models for the user's preferred provider. */
export async function loadPreferredProviderPickerCatalog(params: {
  cfg: OpenClawConfig;
  preferredProvider: string;
  agentDir?: string;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<ModelCatalogEntry[]> {
  const providerFilter = normalizeProviderId(params.preferredProvider);
  if (!providerFilter) {
    return [];
  }
  const catalog = await loadPreparedModelCatalog({
    config: params.cfg,
    agentDir: params.agentDir ?? resolveDefaultAgentDir(params.cfg, params.env),
    ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
    ...(params.env ? { env: params.env } : {}),
  });
  return catalog.filter((entry) => normalizeProviderId(entry.provider) === providerFilter);
}

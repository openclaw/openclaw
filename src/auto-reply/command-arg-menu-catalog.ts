import { resolveAgentDir } from "../agents/agent-scope.js";
import type { ModelCatalogEntry } from "../agents/model-catalog.types.js";
import type { OpenClawConfig } from "../config/types.js";

/**
 * Reads model metadata for native command menus such as /think.
 *
 * Menus are read-only display paths: they follow the currently published model generation
 * instead of requiring it to match the caller's config, and they never start provider discovery.
 */
export async function loadCommandArgMenuModelCatalog(params: {
  cfg: OpenClawConfig;
  agentId?: string;
}): Promise<ModelCatalogEntry[]> {
  const { loadPublishedPreparedModelCatalog } = await import("../agents/prepared-model-catalog.js");
  return await loadPublishedPreparedModelCatalog({
    config: params.cfg,
    ...(params.agentId
      ? { agentId: params.agentId, agentDir: resolveAgentDir(params.cfg, params.agentId) }
      : {}),
    readOnly: true,
  });
}

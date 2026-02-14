import {
  loadModelCatalog,
  type ModelCatalogEntry,
  resetModelCatalogCacheForTest,
} from "../agents/model-catalog.js";
import { loadConfig } from "../config/config.js";
import { resolveAgentDir } from "../agents/agent-scope.js";

export type GatewayModelChoice = ModelCatalogEntry;

// Test-only escape hatch: model catalog is cached at module scope for the
// process lifetime, which is fine for the real gateway daemon, but makes
// isolated unit tests harder. Keep this intentionally obscure.
export function __resetModelCatalogCacheForTest() {
  resetModelCatalogCacheForTest();
}

export async function loadGatewayModelCatalog(agentId?: string): Promise<GatewayModelChoice[]> {
  const cfg = loadConfig();
  
  // If agentId is provided, use the agent-specific directory for model discovery
  const agentDir = agentId ? resolveAgentDir(cfg, agentId) : undefined;
  
  return await loadModelCatalog({ config: cfg, agentDir });
}

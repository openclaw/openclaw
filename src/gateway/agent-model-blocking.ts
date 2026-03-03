import { DEFAULT_PROVIDER } from "../agents/defaults.js";
import type { ModelCatalogEntry } from "../agents/model-catalog.js";
import {
  resolveAgentModelResolutionState,
  type AgentModelResolutionState,
} from "../agents/model-selection.js";
import type { OpenClawConfig } from "../config/config.js";

export function isStrictModelResolutionEnabled(cfg: OpenClawConfig): boolean {
  return cfg.agents?.strictModelResolution === true;
}

export async function resolveGatewayAgentModelState(params: {
  cfg: OpenClawConfig;
  agentId: string;
  loadGatewayModelCatalog?: () => Promise<ModelCatalogEntry[]>;
}): Promise<AgentModelResolutionState> {
  const strictModelResolution = isStrictModelResolutionEnabled(params.cfg);
  let catalog: ModelCatalogEntry[] | undefined;
  if (strictModelResolution && params.loadGatewayModelCatalog) {
    catalog = await params.loadGatewayModelCatalog();
  }
  return resolveAgentModelResolutionState({
    cfg: params.cfg,
    agentId: params.agentId,
    defaultProvider: DEFAULT_PROVIDER,
    strictModelResolution,
    catalog,
  });
}

export function formatBlockedAgentModelReason(state: AgentModelResolutionState): string {
  if (state.status !== "blocked") {
    return "";
  }
  return `${state.code}: ${state.reason}`;
}

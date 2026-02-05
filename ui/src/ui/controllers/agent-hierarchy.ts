import type { GatewayBrowserClient } from "../gateway.ts";
import type { AgentHierarchyResult } from "../types.ts";

export type AgentHierarchyState = {
  client: GatewayBrowserClient | null;
  agentHierarchyLoading: boolean;
  agentHierarchyError: string | null;
  agentHierarchyData: AgentHierarchyResult | null;
};

export async function loadAgentHierarchy(state: AgentHierarchyState): Promise<void> {
  if (!state.client) {
    state.agentHierarchyError = "Not connected to gateway";
    return;
  }
  state.agentHierarchyLoading = true;
  state.agentHierarchyError = null;
  try {
    const result = await state.client.request<AgentHierarchyResult>("agents.hierarchy", {});
    state.agentHierarchyData = result;
  } catch (err) {
    state.agentHierarchyError = String(err);
  } finally {
    state.agentHierarchyLoading = false;
  }
}

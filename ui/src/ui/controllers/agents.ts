import type { GatewayBrowserClient } from "../gateway.ts";
import type {
  AgentsCloneResult,
  AgentsCreateResult,
  AgentsListResult,
  ToolsCatalogResult,
} from "../types.ts";

export type AgentsState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  agentsLoading: boolean;
  agentsError: string | null;
  agentsList: AgentsListResult | null;
  agentsSelectedId: string | null;
  toolsCatalogLoading: boolean;
  toolsCatalogError: string | null;
  toolsCatalogResult: ToolsCatalogResult | null;
};

export async function createAgent(
  state: AgentsState,
  params: {
    name: string;
    workspace: string;
    emoji?: string;
    avatar?: string;
  },
): Promise<AgentsCreateResult | null> {
  if (!state.client || !state.connected) {
    return null;
  }
  if (state.agentsLoading) {
    return null;
  }
  state.agentsLoading = true;
  state.agentsError = null;
  try {
    const res = await state.client.request<AgentsCreateResult>("agents.create", params);
    return res ?? null;
  } catch (err) {
    state.agentsError = String(err);
    return null;
  } finally {
    state.agentsLoading = false;
  }
}

export async function cloneAgent(
  state: AgentsState,
  params: {
    sourceAgentId: string;
    name?: string;
    workspace?: string;
  },
): Promise<AgentsCloneResult | null> {
  if (!state.client || !state.connected) {
    return null;
  }
  if (state.agentsLoading) {
    return null;
  }
  state.agentsLoading = true;
  state.agentsError = null;
  try {
    const res = await state.client.request<AgentsCloneResult>("agents.clone", params);
    return res ?? null;
  } catch (err) {
    state.agentsError = String(err);
    return null;
  } finally {
    state.agentsLoading = false;
  }
}

export async function loadAgents(state: AgentsState) {
  if (!state.client || !state.connected) {
    return;
  }
  if (state.agentsLoading) {
    return;
  }
  state.agentsLoading = true;
  state.agentsError = null;
  try {
    const res = await state.client.request<AgentsListResult>("agents.list", {});
    if (res) {
      state.agentsList = res;
      const selected = state.agentsSelectedId;
      const known = res.agents.some((entry) => entry.id === selected);
      if (!selected || !known) {
        state.agentsSelectedId = res.defaultId ?? res.agents[0]?.id ?? null;
      }
    }
  } catch (err) {
    state.agentsError = String(err);
  } finally {
    state.agentsLoading = false;
  }
}

export async function loadToolsCatalog(state: AgentsState, agentId?: string | null) {
  if (!state.client || !state.connected) {
    return;
  }
  if (state.toolsCatalogLoading) {
    return;
  }
  state.toolsCatalogLoading = true;
  state.toolsCatalogError = null;
  try {
    const res = await state.client.request<ToolsCatalogResult>("tools.catalog", {
      agentId: agentId ?? state.agentsSelectedId ?? undefined,
      includePlugins: true,
    });
    if (res) {
      state.toolsCatalogResult = res;
    }
  } catch (err) {
    state.toolsCatalogError = String(err);
  } finally {
    state.toolsCatalogLoading = false;
  }
}

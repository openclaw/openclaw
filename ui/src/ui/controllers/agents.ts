import type { GatewayBrowserClient } from "../gateway.ts";
import type { AgentsListResult, ToolsCatalogResult } from "../types.ts";

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

export type AgentDeleteState = {
  agentDeleteBusy: boolean;
  agentDeleteError: string | null;
};

export async function deleteAgent(state: AgentsState & AgentDeleteState, agentId: string) {
  if (!state.client || !state.connected) {
    state.agentDeleteError = "Not connected to the gateway.";
    return;
  }
  state.agentDeleteBusy = true;
  state.agentDeleteError = null;
  try {
    await state.client.request<{ ok: true; agentId: string }>("agents.delete", {
      agentId,
      deleteFiles: true,
    });
    // Refresh agent list, retrying with back-off if the deleted agent still appears.
    // Fetch directly instead of going through loadAgents to avoid clearing the
    // single-flight agentsLoading guard, which could let a concurrent request
    // overwrite the post-delete list.
    const maxRetries = 3;
    let removed = false;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) {
        await new Promise((r) => setTimeout(r, attempt * 500));
      }
      const res = await state.client.request<AgentsListResult>("agents.list", {});
      if (res) {
        state.agentsList = res;
        const selected = state.agentsSelectedId;
        const known = res.agents.some((entry) => entry.id === selected);
        if (!selected || !known) {
          state.agentsSelectedId = res.defaultId ?? res.agents[0]?.id ?? null;
        }
      }
      if (!state.agentsList?.agents.some((a) => a.id === agentId)) {
        removed = true;
        break;
      }
    }
    if (!removed) {
      state.agentDeleteError = "Agent deleted but may still appear briefly. Try refreshing.";
    }
  } catch (err) {
    state.agentDeleteError = String(err);
  } finally {
    state.agentDeleteBusy = false;
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

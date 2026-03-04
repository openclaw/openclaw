import type { GatewayBrowserClient } from "../gateway.ts";
import type {
  AgentsCloneResult,
  AgentsCreateResult,
  AgentsDeleteResult,
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

function isLegacyAgentsDeletePurgeStateError(err: unknown): boolean {
  const message = String(err);
  return (
    message.includes("invalid agents.delete params") &&
    message.includes("unexpected property") &&
    message.includes("purgeState")
  );
}

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

export async function deleteAgent(
  state: AgentsState,
  params: {
    agentId: string;
  },
): Promise<AgentsDeleteResult | null> {
  if (!state.client || !state.connected) {
    return null;
  }
  if (state.agentsLoading) {
    return null;
  }
  const agentId = params.agentId.trim();
  if (!agentId) {
    return null;
  }
  const confirmed = window.confirm(
    `Delete agent "${agentId}"?\n\nThis permanently removes its config, sessions, cron jobs, workspace, and agent files.`,
  );
  if (!confirmed) {
    return null;
  }
  state.agentsLoading = true;
  state.agentsError = null;
  try {
    try {
      const res = await state.client.request<AgentsDeleteResult>("agents.delete", {
        agentId,
        deleteFiles: true,
        purgeState: true,
      });
      return res ?? null;
    } catch (err) {
      if (!isLegacyAgentsDeletePurgeStateError(err)) {
        throw err;
      }
      const res = await state.client.request<AgentsDeleteResult>("agents.delete", {
        agentId,
        deleteFiles: true,
      });
      return res ?? null;
    }
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

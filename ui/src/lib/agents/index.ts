import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { normalizeUniqueTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import { registerListener } from "../../../../src/shared/listeners.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type {
  AgentsFilesGetResult,
  AgentsFilesListResult,
  AgentsListResult,
  ToolsCatalogResult,
} from "../../api/types.ts";
import { formatUiError } from "../format-error.ts";
import type { GatewayConnectionSnapshot } from "../gateway-connection-lifecycle.ts";
import {
  formatMissingOperatorReadScopeMessage,
  isMissingOperatorReadScopeError,
} from "../gateway-errors.ts";
import type { AgentsPanel } from "./panels.ts";
import {
  buildToolsEffectiveRequestKey,
  loadToolsEffective as loadToolsEffectiveShared,
  refreshVisibleToolsEffectiveForCurrentSession,
  resetToolsEffectiveState,
  type ToolsEffectiveState,
} from "./tools-effective.ts";

export type { AgentsPanel } from "./panels.ts";
export { watchAgentScope } from "./watch-agent-scope.ts";
export { watchSelectedAgent } from "./watch-selected-agent.ts";

export type AgentsState = ToolsEffectiveState &
  AgentCapabilityState & {
    requestGeneration: number;
    agentsSelectedId: string | null;
    toolsCatalogLoading: boolean;
    toolsCatalogLoadingAgentId?: string | null;
    toolsCatalogError: string | null;
    toolsCatalogResult: ToolsCatalogResult | null;
    sessionKey?: string;
    agentsPanel?: AgentsPanel;
  };

type AgentToolsState = Omit<AgentsState, "agentsLoading" | "agentsError">;

type AgentsConfigCapability = {
  readonly state: { configFormDirty: boolean };
  save: (options?: { canDispatch?: () => boolean }) => Promise<boolean>;
  stageDefaultAgent: (agentId: string) => boolean;
};

type AgentGateway = {
  readonly snapshot: GatewayConnectionSnapshot;
  subscribe: (listener: (snapshot: GatewayConnectionSnapshot) => void) => () => void;
};

type AgentFilesStatus = {
  list: AgentsFilesListResult | null;
  loading: boolean;
  error: string | null;
};

type AgentCapabilityState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  agentsLoading: boolean;
  agentsError: string | null;
  agentsList: AgentsListResult | null;
};

export type AgentCapability = ReturnType<typeof createAgentCapability>;

function resolveAgentReadErrorMessage(
  err: unknown,
  target: "agent list" | "tools catalog" | "effective tools",
): string {
  return isMissingOperatorReadScopeError(err)
    ? formatMissingOperatorReadScopeMessage(target)
    : formatUiError(err);
}

export async function loadToolsCatalog(state: AgentToolsState, agentId: string) {
  const resolvedAgentId = agentId.trim();
  const client = state.client;
  if (
    !client ||
    !state.connected ||
    !resolvedAgentId ||
    (state.toolsCatalogLoading && state.toolsCatalogLoadingAgentId === resolvedAgentId)
  ) {
    return;
  }
  const shouldIgnoreResponse = () =>
    state.client !== client || state.toolsCatalogLoadingAgentId !== resolvedAgentId;
  state.toolsCatalogLoading = true;
  state.toolsCatalogLoadingAgentId = resolvedAgentId;
  state.toolsCatalogError = null;
  state.toolsCatalogResult = null;
  try {
    const res = await client.request<ToolsCatalogResult>("tools.catalog", {
      agentId: resolvedAgentId,
      includePlugins: true,
    });
    if (shouldIgnoreResponse()) {
      return;
    }
    state.toolsCatalogResult = res;
  } catch (err) {
    if (shouldIgnoreResponse()) {
      return;
    }
    state.toolsCatalogError = resolveAgentReadErrorMessage(err, "tools catalog");
  } finally {
    if (state.client === client && state.toolsCatalogLoadingAgentId === resolvedAgentId) {
      state.toolsCatalogLoadingAgentId = null;
      state.toolsCatalogLoading = false;
    }
  }
}

export {
  buildToolsEffectiveRequestKey,
  refreshVisibleToolsEffectiveForCurrentSession,
  resetToolsEffectiveState,
};

export async function loadToolsEffective(
  state: AgentToolsState,
  params: { agentId: string; sessionKey: string },
) {
  await loadToolsEffectiveShared(state, params, {
    onError: (err) => resolveAgentReadErrorMessage(err, "effective tools"),
  });
}

export async function setDefaultAgent(
  config: AgentsConfigCapability,
  agentId: string,
  refreshAgents: () => Promise<unknown>,
  canDispatch: () => boolean = () => true,
): Promise<void> {
  if (!canDispatch()) {
    return;
  }
  const hadPendingConfigDraft = config.state.configFormDirty;
  if (config.stageDefaultAgent(agentId) && !hadPendingConfigDraft && config.state.configFormDirty) {
    const saved = await config.save({ canDispatch });
    if (saved && canDispatch()) {
      await refreshAgents();
    }
  }
}

type AgentIdentityUpdate = {
  agentId: string;
  name?: string;
  emoji?: string;
  avatar?: string;
};

/** Persist identity fields through the gateway; the handler also rewrites the
    agent's workspace IDENTITY.md so agent and UI share one identity source. */
export async function updateAgentIdentity(
  client: GatewayBrowserClient,
  update: AgentIdentityUpdate,
): Promise<void> {
  await client.request("agents.update", {
    agentId: update.agentId,
    ...(update.name ? { name: update.name } : {}),
    ...(update.emoji ? { emoji: update.emoji } : {}),
    ...(update.avatar ? { avatar: update.avatar } : {}),
  });
}

function emptyAgentFilesStatus(): AgentFilesStatus {
  return { list: null, loading: false, error: null };
}

export function createAgentCapability(gateway: AgentGateway) {
  const state: AgentCapabilityState = {
    client: gateway.snapshot.client,
    connected: gateway.snapshot.phase === "connected",
    agentsLoading: false,
    agentsError: null,
    agentsList: null,
  };
  const files = new Map<string, AgentFilesStatus>();
  const fileRequests = new Map<string, Promise<AgentsFilesListResult | null>>();
  const listeners = new Set<(state: AgentCapabilityState) => void>();
  let disposed = false;
  let agentsRequest: Promise<AgentsListResult | null> | null = null;

  const retireAgentsRequest = () => {
    agentsRequest = null;
    state.agentsLoading = false;
  };

  const publish = () => {
    if (disposed) {
      return;
    }
    for (const listener of listeners) {
      listener(state);
    }
  };
  const fileStatus = (agentId: string): AgentFilesStatus => {
    const existing = files.get(agentId);
    if (existing) {
      return existing;
    }
    const next = emptyAgentFilesStatus();
    files.set(agentId, next);
    return next;
  };

  const loadList = async (force: boolean): Promise<AgentsListResult | null> => {
    const client = state.client;
    if (!client || !state.connected || disposed) {
      return state.agentsList;
    }
    if (agentsRequest && !force) {
      return agentsRequest;
    }
    if (state.agentsList && !force) {
      return state.agentsList;
    }
    state.agentsLoading = true;
    state.agentsError = null;
    publish();
    const request: Promise<AgentsListResult | null> = client
      // New Session reads the placement policy from this roster instead of a second request.
      .request<AgentsListResult>("agents.list", { includeSessionPlacement: true })
      .then((result) => {
        const current = state.client === client && agentsRequest === request;
        if (current) {
          state.agentsList = result;
          state.agentsError = null;
        }
        return current ? result : null;
      })
      .catch((err: unknown) => {
        if (state.client === client && agentsRequest === request) {
          state.agentsList = null;
          state.agentsError = resolveAgentReadErrorMessage(err, "agent list");
        }
        return null;
      })
      .finally(() => {
        const currentRequest = agentsRequest === request;
        if (currentRequest) {
          agentsRequest = null;
        }
        if (currentRequest && state.client === client) {
          state.agentsLoading = false;
          publish();
        }
      });
    agentsRequest = request;
    return request;
  };

  const loadFiles = async (
    rawAgentId: string,
    force: boolean,
  ): Promise<AgentsFilesListResult | null> => {
    const agentId = normalizeOptionalString(rawAgentId);
    const client = state.client;
    if (!agentId || !client || !state.connected || disposed) {
      return agentId ? (files.get(agentId)?.list ?? null) : null;
    }
    const status = fileStatus(agentId);
    if (status.list && !force) {
      return status.list;
    }
    const activeRequest = fileRequests.get(agentId);
    if (activeRequest && !force) {
      return activeRequest;
    }
    status.loading = true;
    status.error = null;
    publish();
    const request: Promise<AgentsFilesListResult | null> = client
      .request<AgentsFilesListResult | null>("agents.files.list", { agentId })
      .then((result) => {
        const current = state.client === client && fileRequests.get(agentId) === request;
        if (current && result) {
          status.list = result;
          status.error = null;
        }
        return current ? status.list : null;
      })
      .catch((err: unknown) => {
        if (state.client === client && fileRequests.get(agentId) === request) {
          status.error = formatUiError(err);
        }
        return null;
      })
      .finally(() => {
        const currentRequest = fileRequests.get(agentId) === request;
        if (currentRequest) {
          fileRequests.delete(agentId);
        }
        if (currentRequest && state.client === client) {
          status.loading = false;
          publish();
        }
      });
    fileRequests.set(agentId, request);
    return request;
  };

  const stopGateway = gateway.subscribe((snapshot) => {
    const clientChanged = state.client !== snapshot.client;
    const connected = snapshot.phase === "connected";
    const connectionChanged = clientChanged || state.connected !== connected;
    state.client = snapshot.client;
    state.connected = connected;
    if (connectionChanged && (clientChanged || !connected)) {
      retireAgentsRequest();
      fileRequests.clear();
      for (const status of files.values()) {
        status.loading = false;
      }
      files.clear();
      state.agentsList = null;
      state.agentsError = null;
    }
    if (connectionChanged) {
      publish();
    }
  });

  return {
    get state() {
      return state;
    },
    ensureList: () => loadList(false),
    refreshList: () => loadList(true),
    files(agentId: string | null | undefined) {
      const normalized = normalizeOptionalString(agentId);
      return normalized
        ? (files.get(normalized) ?? emptyAgentFilesStatus())
        : emptyAgentFilesStatus();
    },
    invalidateFiles(agentIds: readonly (string | null | undefined)[]) {
      let changed = false;
      for (const agentId of normalizeUniqueTrimmedStringList(agentIds)) {
        changed = files.delete(agentId) || changed;
        changed = fileRequests.delete(agentId) || changed;
      }
      if (changed) {
        publish();
      }
    },
    ensureFiles: (agentId: string) => loadFiles(agentId, false),
    refreshFiles: (agentId: string) => loadFiles(agentId, true),
    recordFile({ agentId, file }: AgentsFilesGetResult) {
      const status = fileStatus(agentId);
      if (!status.list) {
        // Reconnect/config invalidation can clear the list while an editor
        // remains open. Rebuild the full list after the confirmed operation.
        void loadFiles(agentId, true);
        return;
      }
      // A confirmed file result supersedes lists already in flight. Retain the
      // full canonical list so their awaiting callers can still read it.
      fileRequests.delete(agentId);
      const entry = { ...file };
      delete entry.content;
      const entries = status.list.files;
      status.list = {
        ...status.list,
        files: entries.some((existing) => existing.name === entry.name)
          ? entries.map((existing) => (existing.name === entry.name ? entry : existing))
          : [...entries, entry],
      };
      status.loading = false;
      status.error = null;
      publish();
    },
    subscribe(listener: (state: AgentCapabilityState) => void) {
      return registerListener(listeners, listener);
    },
    dispose() {
      disposed = true;
      stopGateway();
      listeners.clear();
      fileRequests.clear();
      files.clear();
      retireAgentsRequest();
    },
  };
}

// Control UI controller manages agents gateway state.
import type {
  AgentsListResult,
  ModelCatalogEntry,
  SessionsListResult,
  ToolsCatalogResult,
  ToolsEffectiveResult,
} from "../../api/types.ts";
import {
  buildToolsEffectiveRequestKey,
  loadToolsEffective as loadToolsEffectiveShared,
  refreshVisibleToolsEffectiveForCurrentSession,
  resetToolsEffectiveState,
} from "../../lib/agents/tools-effective.ts";
import { loadChannels, type ChannelsState } from "../../lib/channels/index.ts";
import type { RuntimeConfigCapability } from "../../lib/config/index.ts";
import {
  formatMissingOperatorReadScopeMessage,
  isMissingOperatorReadScopeError,
} from "../../lib/gateway-errors.ts";
import type { SessionCapability } from "../../lib/sessions/index.ts";
import type { GatewayBrowserClient } from "../../ui/gateway.ts";
import { loadAgentFiles, type AgentFilesState } from "./files.ts";
import { loadAgentIdentities, loadAgentIdentity, type AgentIdentityState } from "./identity.ts";
import { loadAgentSkills, type AgentSkillsState } from "./skills.ts";

export type AgentsState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  agentsLoading: boolean;
  agentsError: string | null;
  agentsList: AgentsListResult | null;
  agentsSelectedId: string | null;
  sessions: Pick<SessionCapability, "state">;
  toolsCatalogLoading: boolean;
  toolsCatalogLoadingAgentId?: string | null;
  toolsCatalogError: string | null;
  toolsCatalogResult: ToolsCatalogResult | null;
  toolsEffectiveLoading: boolean;
  toolsEffectiveLoadingKey?: string | null;
  toolsEffectiveResultKey?: string | null;
  toolsEffectiveError: string | null;
  toolsEffectiveResult: ToolsEffectiveResult | null;
  sessionKey?: string;
  sessionsResult?: SessionsListResult | null;
  chatModelCatalog?: ModelCatalogEntry[];
  agentsPanel?: "overview" | "files" | "tools" | "skills" | "channels" | "cron";
};

export type AgentsConfigCapability = Pick<
  RuntimeConfigCapability,
  "refresh" | "save" | "stageDefaultAgent" | "state"
>;

type AgentsPageState = AgentsState &
  AgentIdentityState &
  AgentFilesState &
  AgentSkillsState &
  ChannelsState & {
    loadCron?: () => void;
  };

export async function loadAgentsPage(state: AgentsPageState, config: AgentsConfigCapability) {
  await loadAgents(state);
  await config.refresh();
  const agentIds = state.agentsList?.agents?.map((entry) => entry.id) ?? [];
  if (agentIds.length > 0) {
    void loadAgentIdentities(state, agentIds);
  }
  const agentId =
    state.agentsSelectedId ?? state.agentsList?.defaultId ?? state.agentsList?.agents?.[0]?.id;
  if (!agentId) {
    return;
  }
  void loadAgentIdentity(state, agentId);
  switch (state.agentsPanel) {
    case "files":
      void loadAgentFiles(state, agentId);
      return;
    case "skills":
      void loadAgentSkills(state, agentId);
      return;
    case "channels":
      void loadChannels(state, false);
      return;
    case "cron":
      void state.loadCron?.();
    case "overview":
    case "tools":
    case undefined:
  }
}

function hasSelectedAgentMismatch(state: AgentsState, agentId: string): boolean {
  return Boolean(state.agentsSelectedId && state.agentsSelectedId !== agentId);
}

function resolveToolsErrorMessage(
  err: unknown,
  target: "tools catalog" | "effective tools",
): string {
  return isMissingOperatorReadScopeError(err)
    ? formatMissingOperatorReadScopeMessage(target)
    : String(err);
}

export async function loadAgents(state: AgentsState) {
  if (!state.client || !state.connected || state.agentsLoading) {
    return;
  }
  state.agentsLoading = true;
  state.agentsError = null;
  try {
    const res = await state.client.request<AgentsListResult>("agents.list", {});
    if (res) {
      state.agentsList = res;
      const selected = state.agentsSelectedId;
      if (!selected || !res.agents.some((entry) => entry.id === selected)) {
        state.agentsSelectedId = res.defaultId ?? res.agents[0]?.id ?? null;
      }
    }
  } catch (err) {
    if (isMissingOperatorReadScopeError(err)) {
      state.agentsList = null;
      state.agentsError = formatMissingOperatorReadScopeMessage("agent list");
    } else {
      state.agentsError = String(err);
    }
  } finally {
    state.agentsLoading = false;
  }
}

export async function loadToolsCatalog(state: AgentsState, agentId: string) {
  const resolvedAgentId = agentId.trim();
  if (
    !state.client ||
    !state.connected ||
    !resolvedAgentId ||
    (state.toolsCatalogLoading && state.toolsCatalogLoadingAgentId === resolvedAgentId)
  ) {
    return;
  }
  const shouldIgnoreResponse = () =>
    state.toolsCatalogLoadingAgentId !== resolvedAgentId ||
    hasSelectedAgentMismatch(state, resolvedAgentId);
  state.toolsCatalogLoading = true;
  state.toolsCatalogLoadingAgentId = resolvedAgentId;
  state.toolsCatalogError = null;
  state.toolsCatalogResult = null;
  try {
    const res = await state.client.request<ToolsCatalogResult>("tools.catalog", {
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
    state.toolsCatalogError = resolveToolsErrorMessage(err, "tools catalog");
  } finally {
    if (state.toolsCatalogLoadingAgentId === resolvedAgentId) {
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
  state: AgentsState,
  params: { agentId: string; sessionKey: string },
) {
  await loadToolsEffectiveShared(state, params, {
    ignoreResponse: (agentId, requestKey) =>
      state.toolsEffectiveLoadingKey !== requestKey || hasSelectedAgentMismatch(state, agentId),
    onError: (err) => resolveToolsErrorMessage(err, "effective tools"),
  });
}

export async function saveAgentsConfig(state: AgentsState, config: AgentsConfigCapability) {
  const selectedBefore = state.agentsSelectedId;
  await config.save();
  await loadAgents(state);
  if (selectedBefore && state.agentsList?.agents.some((entry) => entry.id === selectedBefore)) {
    state.agentsSelectedId = selectedBefore;
  }
}

export async function setDefaultAgent(
  state: AgentsState,
  config: AgentsConfigCapability,
  agentId: string,
): Promise<void> {
  const hadPendingConfigDraft = config.state.configFormDirty;
  // Set Default is a one-click action on a clean draft, but saveConfig serializes the
  // whole form. If other edits were already dirty, keep them staged for the explicit
  // Save button instead of committing unrelated pending config changes.
  if (config.stageDefaultAgent(agentId)) {
    if (!hadPendingConfigDraft && config.state.configFormDirty) {
      await saveAgentsConfig(state, config);
    }
  }
}

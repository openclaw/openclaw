import type { AgentsListResult } from "../api/types.ts";
import { normalizeAgentId, parseAgentSessionKey } from "../lib/sessions/session-key.ts";
import type { UiPreferences } from "./settings.ts";

type AgentSelectionGateway = {
  readonly connection: {
    gatewayUrl: string;
  };
  readonly snapshot: {
    assistantAgentId: string | null;
  };
  subscribe: (listener: (snapshot: AgentSelectionGateway["snapshot"]) => void) => () => void;
};

type AgentSelectionPersistence = {
  load: (gatewayUrl: string) => string | null;
  save: (gatewayUrl: string, selectedAgentId: string | null) => void;
};

type AgentSelectionRoster = {
  readonly state: { agentsList: AgentsListResult | null };
  subscribe: (listener: () => void) => () => void;
};

type AgentSelectionPreferences = {
  readonly settings: Pick<
    UiPreferences,
    "gatewayUrl" | "sidebarAgentsMode" | "sidebarPreTeamScope"
  >;
  patch: (patch: Pick<UiPreferences, "sidebarPreTeamScope">) => void;
  subscribe: (listener: () => void) => () => void;
};

type AgentSelectionState = {
  selectedId: string | null;
  /** Agent filter shared by agent-owned pages; null exposes all agents. */
  scopeId: string | null;
};

export type AgentSelectionCapability = {
  readonly state: AgentSelectionState;
  set: (agentId: string | null) => void;
  setScope: (agentId: string | null) => void;
  subscribe: (listener: (state: AgentSelectionState) => void) => () => void;
};

/** Change application ownership before the Gateway session so every navigation
 * caller observes one ordered state transition. Canonical global keys need the
 * explicit agent carried by their data-plane event or owning UI surface. */
export function selectApplicationSession(params: {
  selection: Pick<AgentSelectionCapability, "set">;
  gateway: { setSessionKey: (sessionKey: string) => void };
  sessionKey: string;
  agentId?: string | null;
}): void {
  const agentId = params.agentId?.trim() || parseAgentSessionKey(params.sessionKey)?.agentId;
  if (agentId) {
    params.selection.set(normalizeAgentId(agentId));
  }
  params.gateway.setSessionKey(params.sessionKey);
}

export function createAgentSelectionCapability(
  gateway: AgentSelectionGateway,
  roster: AgentSelectionRoster,
  persistence?: AgentSelectionPersistence,
  preferences?: AgentSelectionPreferences,
): AgentSelectionCapability & { dispose: () => void } {
  const reconcileSelectedId = (value: string | null): string | null => {
    const selectedId = value?.trim() ? normalizeAgentId(value) : null;
    const agentsList = roster.state.agentsList;
    if (!agentsList || agentsList.agents.length === 0) {
      return selectedId;
    }
    const defaultId = normalizeAgentId(agentsList.defaultId);
    return !selectedId ||
      !agentsList.agents.some((agent) => normalizeAgentId(agent.id) === selectedId)
      ? defaultId
      : selectedId;
  };
  const resolveScopeId = (value: string | null): string | null => {
    const scopeId = value?.trim() ? normalizeAgentId(value) : null;
    // System agents remain valid concrete chat targets, but never become shared page filters.
    const isSystem = roster.state.agentsList?.agents.some(
      (agent) => agent.kind === "system" && normalizeAgentId(agent.id) === scopeId,
    );
    return isSystem ? null : scopeId;
  };
  let gatewayUrl = gateway.connection.gatewayUrl;
  const persistedId = persistence?.load(gatewayUrl)?.trim();
  const initialId = persistedId
    ? normalizeAgentId(persistedId)
    : gateway.snapshot.assistantAgentId
      ? normalizeAgentId(gateway.snapshot.assistantAgentId)
      : null;
  const initialSelectedId = reconcileSelectedId(initialId);
  let teamMode = preferences?.settings.sidebarAgentsMode === "roster";
  const rememberedScope = (fallback: string | null) =>
    resolveScopeId(
      preferences?.settings.sidebarPreTeamScope === undefined
        ? fallback
        : preferences.settings.sidebarPreTeamScope,
    );
  let previousScopeId = rememberedScope(initialSelectedId);
  let previousScopeNeedsRoster =
    preferences?.settings.sidebarPreTeamScope === undefined && !roster.state.agentsList;
  let scopeNeedsRoster = !teamMode && previousScopeNeedsRoster;
  let configuredIds = new Set(
    roster.state.agentsList?.agents.map((agent) => normalizeAgentId(agent.id)),
  );
  let state: AgentSelectionState = {
    selectedId: initialSelectedId,
    scopeId: teamMode ? null : previousScopeId,
  };
  let assistantAgentId = gateway.snapshot.assistantAgentId
    ? normalizeAgentId(gateway.snapshot.assistantAgentId)
    : null;
  let followsGatewayDefault = !persistedId || initialSelectedId !== normalizeAgentId(persistedId);
  if (persistedId && followsGatewayDefault) {
    persistence?.save(gatewayUrl, null);
  }
  const listeners = new Set<(next: AgentSelectionState) => void>();

  const publish = (next: AgentSelectionState) => {
    const selectedId = reconcileSelectedId(next.selectedId);
    // Selection and page scope move together when a configured agent vanishes.
    // Otherwise route-derived agent ids keep sending agent-scoped RPCs to a dead target.
    const scopeId = teamMode || selectedId === next.selectedId ? next.scopeId : selectedId;
    const reconciled = { selectedId, scopeId: resolveScopeId(scopeId) };
    if (state.selectedId === reconciled.selectedId && state.scopeId === reconciled.scopeId) {
      return;
    }
    state = reconciled;
    for (const listener of listeners) {
      listener(state);
    }
  };

  const stopPreferences = preferences?.subscribe(() => {
    // The preference owner refreshes first on Gateway changes; selection handles
    // that transition below without restoring the previous Gateway's filter.
    if (gateway.connection.gatewayUrl !== gatewayUrl) {
      return;
    }
    const nextTeamMode = preferences.settings.sidebarAgentsMode === "roster";
    if (nextTeamMode === teamMode) {
      return;
    }
    teamMode = nextTeamMode;
    if (teamMode) {
      previousScopeId = state.scopeId;
      previousScopeNeedsRoster = scopeNeedsRoster;
    } else {
      previousScopeId = rememberedScope(previousScopeId);
    }
    scopeNeedsRoster = !teamMode && previousScopeNeedsRoster;
    preferences.patch({ sidebarPreTeamScope: teamMode ? previousScopeId : undefined });
    publish({ ...state, scopeId: teamMode ? null : previousScopeId });
  });
  const stopGateway = gateway.subscribe((next) => {
    const nextAssistantAgentId = next.assistantAgentId
      ? normalizeAgentId(next.assistantAgentId)
      : null;
    const assistantChanged = nextAssistantAgentId !== assistantAgentId;
    assistantAgentId = nextAssistantAgentId;
    const nextGatewayUrl = gateway.connection.gatewayUrl;
    if (nextGatewayUrl !== gatewayUrl) {
      gatewayUrl = nextGatewayUrl;
      const nextPersistedId = persistence?.load(gatewayUrl)?.trim();
      followsGatewayDefault = !nextPersistedId;
      const selectedId = nextPersistedId ? normalizeAgentId(nextPersistedId) : nextAssistantAgentId;
      teamMode = preferences?.settings.sidebarAgentsMode === "roster";
      previousScopeId = rememberedScope(selectedId);
      previousScopeNeedsRoster =
        preferences?.settings.sidebarPreTeamScope === undefined && !roster.state.agentsList;
      scopeNeedsRoster = !teamMode && previousScopeNeedsRoster;
      configuredIds.clear();
      // AgentCapability subscribes first and clears the old roster on a
      // connection change, so a target Gateway's saved id is not judged
      // against the previous Gateway's agents.
      publish({ selectedId, scopeId: teamMode ? null : previousScopeId });
      return;
    }
    // A reconnect publishes a transient null before hello. Keep the last
    // implicit default selected until the next authoritative default arrives.
    if (assistantChanged && followsGatewayDefault && nextAssistantAgentId) {
      if (!teamMode) {
        scopeNeedsRoster = !roster.state.agentsList;
      }
      publish({
        selectedId: nextAssistantAgentId,
        scopeId: teamMode ? state.scopeId : nextAssistantAgentId,
      });
    }
  });
  const stopRoster = roster.subscribe(() => {
    const nextIds = new Set(
      roster.state.agentsList?.agents.map((agent) => normalizeAgentId(agent.id)),
    );
    let scopeId = state.scopeId;
    if (nextIds.size > 0) {
      // A saved selection can disappear before the first roster arrives. Explicit
      // historical page filters remain valid even when they are no longer configured.
      if (
        previousScopeId &&
        (previousScopeNeedsRoster || configuredIds.has(previousScopeId)) &&
        !nextIds.has(previousScopeId)
      ) {
        previousScopeId = resolveScopeId(reconcileSelectedId(previousScopeId));
        if (teamMode) {
          preferences?.patch({ sidebarPreTeamScope: previousScopeId });
        }
      }
      previousScopeNeedsRoster = false;
      scopeNeedsRoster = false;
      if (
        teamMode &&
        state.scopeId &&
        configuredIds.has(state.scopeId) &&
        !nextIds.has(state.scopeId)
      ) {
        scopeId = null;
      }
      configuredIds = nextIds;
    }
    // Re-enable implicit ownership before publishing the roster fallback. A
    // synchronous subscriber may establish a new explicit owner during publish.
    if (!followsGatewayDefault && reconcileSelectedId(state.selectedId) !== state.selectedId) {
      followsGatewayDefault = true;
      persistence?.save(gatewayUrl, null);
    }
    if (followsGatewayDefault && assistantAgentId) {
      publish({
        selectedId: assistantAgentId,
        scopeId: teamMode || state.selectedId === assistantAgentId ? scopeId : assistantAgentId,
      });
    } else {
      publish({ ...state, scopeId });
    }
  });

  return {
    get state() {
      return state;
    },
    set(agentId) {
      const selectedId = agentId?.trim() ? normalizeAgentId(agentId) : null;
      // Team navigation changes chat ownership without replacing a page's filter.
      // Establish ownership before publish notifies synchronous subscribers.
      followsGatewayDefault = !selectedId || reconcileSelectedId(selectedId) !== selectedId;
      if (!teamMode) {
        scopeNeedsRoster = !roster.state.agentsList;
      }
      persistence?.save(gatewayUrl, followsGatewayDefault ? null : selectedId);
      publish({ selectedId, scopeId: teamMode ? state.scopeId : selectedId });
    },
    setScope(agentId) {
      scopeNeedsRoster = false;
      const scopeId = agentId?.trim() ? normalizeAgentId(agentId) : null;
      publish({ ...state, scopeId });
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      stopPreferences?.();
      stopGateway();
      stopRoster();
      listeners.clear();
    },
  };
}

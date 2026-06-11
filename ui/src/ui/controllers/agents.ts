import {
  normalizeChatModelOverrideValue,
  resolvePreferredServerChatModelValue,
} from "../chat-model-ref.ts";
import type { GatewayBrowserClient } from "../gateway.ts";
import { resolveAgentIdFromSessionKey } from "../session-key.ts";
import type {
  AgentsListResult,
  AgentsRuntimeStatusResult,
  ChatModelOverride,
  ModelCatalogEntry,
  OpsSummaryResult,
  SessionsListResult,
  ToolsCatalogResult,
  ToolsEffectiveResult,
} from "../types.ts";
import type { AgentsPanel } from "../views/agents.types.ts";
import { saveConfig } from "./config.ts";
import type { ConfigState } from "./config.ts";
import {
  formatMissingOperatorReadScopeMessage,
  isMissingOperatorReadScopeError,
} from "./scope-errors.ts";

const SUPPLEMENTAL_DASHBOARD_REQUEST_TIMEOUT_MS = 15_000;

export type AgentsState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  agentsLoading: boolean;
  agentsError: string | null;
  agentsList: AgentsListResult | null;
  agentsSelectedId: string | null;
  agentsRuntimeLoading?: boolean;
  agentsRuntimeError?: string | null;
  agentsRuntimeStatus?: AgentsRuntimeStatusResult | null;
  opsSummaryLoading?: boolean;
  opsSummaryError?: string | null;
  opsSummary?: OpsSummaryResult | null;
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
  chatModelOverrides?: Record<string, ChatModelOverride | null>;
  chatModelCatalog?: ModelCatalogEntry[];
  agentsPanel?: AgentsPanel;
};

export type AgentsConfigSaveState = AgentsState & ConfigState;

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

export async function loadOpsSummary(state: AgentsState) {
  if (!state.client || !state.connected || state.opsSummaryLoading) {
    return;
  }
  state.opsSummaryLoading = true;
  state.opsSummaryError = null;
  try {
    const res = await state.client.request<OpsSummaryResult>(
      "ops.summary",
      {},
      { timeoutMs: SUPPLEMENTAL_DASHBOARD_REQUEST_TIMEOUT_MS },
    );
    state.opsSummary = res ?? null;
  } catch (err) {
    state.opsSummary = null;
    const message = String(err);
    if (/unknown method:\s*ops\.summary/i.test(message)) {
      state.opsSummaryError =
        "Gateway operations summary is not available from the running gateway yet.";
      return;
    }
    state.opsSummaryError = isMissingOperatorReadScopeError(err)
      ? formatMissingOperatorReadScopeMessage("operations summary")
      : message;
  } finally {
    state.opsSummaryLoading = false;
  }
}

export async function loadAgentsRuntimeStatus(state: AgentsState) {
  if (!state.client || !state.connected) {
    return;
  }
  if (state.agentsRuntimeLoading) {
    return;
  }
  state.agentsRuntimeLoading = true;
  state.agentsRuntimeError = null;
  try {
    const res = await state.client.request<AgentsRuntimeStatusResult>(
      "agents.runtime.status",
      {},
      { timeoutMs: SUPPLEMENTAL_DASHBOARD_REQUEST_TIMEOUT_MS },
    );
    state.agentsRuntimeStatus = res ?? null;
  } catch (err) {
    state.agentsRuntimeStatus = null;
    const message = String(err);
    if (/unknown method:\s*agents\.runtime\.status/i.test(message)) {
      state.agentsRuntimeError =
        "Runtime memory telemetry is not available from the running gateway yet.";
      return;
    }
    state.agentsRuntimeError = isMissingOperatorReadScopeError(err)
      ? formatMissingOperatorReadScopeMessage("agent runtime status")
      : message;
  } finally {
    state.agentsRuntimeLoading = false;
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

export async function loadToolsEffective(
  state: AgentsState,
  params: { agentId: string; sessionKey: string },
) {
  const resolvedAgentId = params.agentId.trim();
  const resolvedSessionKey = params.sessionKey.trim();
  const requestKey = buildToolsEffectiveRequestKey(state, {
    agentId: resolvedAgentId,
    sessionKey: resolvedSessionKey,
  });
  if (
    !state.client ||
    !state.connected ||
    !resolvedAgentId ||
    !resolvedSessionKey ||
    (state.toolsEffectiveLoading && state.toolsEffectiveLoadingKey === requestKey)
  ) {
    return;
  }
  const shouldIgnoreResponse = () =>
    state.toolsEffectiveLoadingKey !== requestKey ||
    hasSelectedAgentMismatch(state, resolvedAgentId);
  state.toolsEffectiveLoading = true;
  state.toolsEffectiveLoadingKey = requestKey;
  state.toolsEffectiveResultKey = null;
  state.toolsEffectiveError = null;
  state.toolsEffectiveResult = null;
  try {
    const res = await state.client.request<ToolsEffectiveResult>("tools.effective", {
      agentId: resolvedAgentId,
      sessionKey: resolvedSessionKey,
    });
    if (shouldIgnoreResponse()) {
      return;
    }
    state.toolsEffectiveResultKey = requestKey;
    state.toolsEffectiveResult = res;
  } catch (err) {
    if (shouldIgnoreResponse()) {
      return;
    }
    state.toolsEffectiveError = resolveToolsErrorMessage(err, "effective tools");
  } finally {
    if (state.toolsEffectiveLoadingKey === requestKey) {
      state.toolsEffectiveLoadingKey = null;
      state.toolsEffectiveLoading = false;
    }
  }
}

export function resetToolsEffectiveState(state: AgentsState) {
  state.toolsEffectiveResult = null;
  state.toolsEffectiveResultKey = null;
  state.toolsEffectiveError = null;
  state.toolsEffectiveLoading = false;
  state.toolsEffectiveLoadingKey = null;
}

export function buildToolsEffectiveRequestKey(
  state: Pick<AgentsState, "sessionsResult" | "chatModelOverrides" | "chatModelCatalog">,
  params: { agentId: string; sessionKey: string },
): string {
  const resolvedAgentId = params.agentId.trim();
  const resolvedSessionKey = params.sessionKey.trim();
  const modelKey = resolveEffectiveToolsModelKey(state, resolvedSessionKey);
  return `${resolvedAgentId}:${resolvedSessionKey}:model=${modelKey || "(default)"}`;
}

export function refreshVisibleToolsEffectiveForCurrentSession(
  state: AgentsState,
): Promise<void> | undefined {
  const resolvedSessionKey = state.sessionKey?.trim();
  if (!resolvedSessionKey || state.agentsPanel !== "tools" || !state.agentsSelectedId) {
    return undefined;
  }
  const sessionAgentId = resolveAgentIdFromSessionKey(resolvedSessionKey);
  if (!sessionAgentId || state.agentsSelectedId !== sessionAgentId) {
    return undefined;
  }
  return loadToolsEffective(state, {
    agentId: sessionAgentId,
    sessionKey: resolvedSessionKey,
  });
}

function resolveEffectiveToolsModelKey(
  state: Pick<AgentsState, "sessionsResult" | "chatModelOverrides" | "chatModelCatalog">,
  sessionKey: string,
): string {
  const resolvedSessionKey = sessionKey.trim();
  if (!resolvedSessionKey) {
    return "";
  }
  const catalog = state.chatModelCatalog ?? [];
  const cachedOverride = state.chatModelOverrides?.[resolvedSessionKey];
  const defaults = state.sessionsResult?.defaults;
  const defaultModel = resolvePreferredServerChatModelValue(
    defaults?.model,
    defaults?.modelProvider,
    catalog,
  );
  if (cachedOverride === null) {
    return defaultModel;
  }
  if (cachedOverride) {
    return normalizeChatModelOverrideValue(cachedOverride, catalog);
  }
  const activeRow = state.sessionsResult?.sessions?.find((row) => row.key === resolvedSessionKey);
  if (activeRow?.model) {
    return resolvePreferredServerChatModelValue(activeRow.model, activeRow.modelProvider, catalog);
  }
  return defaultModel;
}

export async function saveAgentsConfig(state: AgentsConfigSaveState) {
  const selectedBefore = state.agentsSelectedId;
  await saveConfig(state);
  await loadAgents(state);
  if (selectedBefore && state.agentsList?.agents.some((entry) => entry.id === selectedBefore)) {
    state.agentsSelectedId = selectedBefore;
  }
}

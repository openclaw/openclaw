import { resolveAgentIdFromSessionKey } from "../../../../src/routing/session-key.js";
import {
	resolveChatModelOverride,
	resolvePreferredServerChatModelValue,
} from "../chat-model-ref.ts";
import type { GatewayBrowserClient } from "../gateway.ts";
import type {
	AgentsListResult,
	ChatModelOverride,
	ModelCatalogEntry,
	SessionsListResult,
	ToolsCatalogResult,
	ToolsEffectiveResult,
} from "../types.ts";
import type { ConfigState } from "./config.ts";
import { saveConfig } from "./config.ts";
import {
	formatMissingOperatorReadScopeMessage,
	isMissingOperatorReadScopeError,
} from "./scope-errors.ts";

export type AgentsState = {
	client: GatewayBrowserClient | null;
	connected: boolean;
	agentsLoading: boolean;
	agentsError: string | null;
	agentsList: AgentsListResult | null;
	agentsSelectedId: string | null;
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
	agentsPanel?: "overview" | "files" | "tools" | "skills" | "channels" | "cron";
};

export type AgentsConfigSaveState = AgentsState & ConfigState;

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
	if (!state.client || !state.connected || !resolvedAgentId) {
		return;
	}
	if (
		state.toolsCatalogLoading &&
		state.toolsCatalogLoadingAgentId === resolvedAgentId
	) {
		return;
	}
	state.toolsCatalogLoading = true;
	state.toolsCatalogLoadingAgentId = resolvedAgentId;
	state.toolsCatalogError = null;
	state.toolsCatalogResult = null;
	try {
		const res = await state.client.request<ToolsCatalogResult>(
			"tools.catalog",
			{
				agentId: resolvedAgentId,
				includePlugins: true,
			},
		);
		if (state.toolsCatalogLoadingAgentId !== resolvedAgentId) {
			return;
		}
		if (state.agentsSelectedId && state.agentsSelectedId !== resolvedAgentId) {
			return;
		}
		state.toolsCatalogResult = res;
	} catch (err) {
		if (state.toolsCatalogLoadingAgentId !== resolvedAgentId) {
			return;
		}
		if (state.agentsSelectedId && state.agentsSelectedId !== resolvedAgentId) {
			return;
		}
		state.toolsCatalogResult = null;
		state.toolsCatalogError = isMissingOperatorReadScopeError(err)
			? formatMissingOperatorReadScopeMessage("tools catalog")
			: String(err);
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
		!resolvedSessionKey
	) {
		return;
	}
	if (
		state.toolsEffectiveLoading &&
		state.toolsEffectiveLoadingKey === requestKey
	) {
		return;
	}
	state.toolsEffectiveLoading = true;
	state.toolsEffectiveLoadingKey = requestKey;
	state.toolsEffectiveResultKey = null;
	state.toolsEffectiveError = null;
	state.toolsEffectiveResult = null;
	try {
		const res = await state.client.request<ToolsEffectiveResult>(
			"tools.effective",
			{
				agentId: resolvedAgentId,
				sessionKey: resolvedSessionKey,
			},
		);
		if (state.toolsEffectiveLoadingKey !== requestKey) {
			return;
		}
		if (state.agentsSelectedId && state.agentsSelectedId !== resolvedAgentId) {
			return;
		}
		state.toolsEffectiveResultKey = requestKey;
		state.toolsEffectiveResult = res;
	} catch (err) {
		if (state.toolsEffectiveLoadingKey !== requestKey) {
			return;
		}
		if (state.agentsSelectedId && state.agentsSelectedId !== resolvedAgentId) {
			return;
		}
		state.toolsEffectiveResult = null;
		state.toolsEffectiveResultKey = null;
		state.toolsEffectiveError = isMissingOperatorReadScopeError(err)
			? formatMissingOperatorReadScopeMessage("effective tools")
			: String(err);
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
	state: Pick<
		AgentsState,
		"sessionsResult" | "chatModelOverrides" | "chatModelCatalog"
	>,
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
	if (
		!resolvedSessionKey ||
		state.agentsPanel !== "tools" ||
		!state.agentsSelectedId
	) {
		return;
	}
	const sessionAgentId = resolveAgentIdFromSessionKey(resolvedSessionKey);
	if (!sessionAgentId || state.agentsSelectedId !== sessionAgentId) {
		return;
	}
	return loadToolsEffective(state, {
		agentId: sessionAgentId,
		sessionKey: resolvedSessionKey,
	});
}

function resolveEffectiveToolsModelKey(
	state: Pick<
		AgentsState,
		"sessionsResult" | "chatModelOverrides" | "chatModelCatalog"
	>,
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
		return resolveChatModelOverride(cachedOverride, catalog).value;
	}
	const activeRow = state.sessionsResult?.sessions?.find(
		(row) => row.key === resolvedSessionKey,
	);
	if (activeRow?.model) {
		return resolvePreferredServerChatModelValue(
			activeRow.model,
			activeRow.modelProvider,
			catalog,
		);
	}
	return defaultModel;
}

export async function saveAgentsConfig(state: AgentsConfigSaveState) {
	const selectedBefore = state.agentsSelectedId;
	await saveConfig(state);
	await loadAgents(state);
	if (
		selectedBefore &&
		state.agentsList?.agents.some((entry) => entry.id === selectedBefore)
	) {
		state.agentsSelectedId = selectedBefore;
	}
}

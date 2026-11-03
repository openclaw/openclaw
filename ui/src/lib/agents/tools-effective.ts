import type { ModelCatalogEntry, SessionsListResult } from "../../api/types.ts";
import {
  normalizeChatModelOverrideValue,
  resolvePreferredServerChatModelValue,
} from "../chat/model-ref.ts";
import type { SessionCapability } from "../sessions/index.ts";

export type ToolsEffectiveModelState = {
  chatModelCatalog?: ModelCatalogEntry[];
  sessions: Pick<SessionCapability, "state">;
  sessionsResult?: SessionsListResult | null;
};

export function buildToolsEffectiveRequestKey(
  state: ToolsEffectiveModelState,
  params: { agentId: string; sessionKey: string },
): string {
  const resolvedAgentId = params.agentId.trim();
  const resolvedSessionKey = params.sessionKey.trim();
  const modelKey = resolveEffectiveToolsModelKey(state, resolvedSessionKey);
  return `${resolvedAgentId}:${resolvedSessionKey}:model=${modelKey || "(default)"}`;
}

function resolveEffectiveToolsModelKey(
  state: ToolsEffectiveModelState,
  sessionKey: string,
): string {
  if (!sessionKey) {
    return "";
  }
  const catalog = state.chatModelCatalog ?? [];
  const cachedOverride = state.sessions.state.modelOverrides[sessionKey];
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
  const activeRow = state.sessionsResult?.sessions.find((row) => row.key === sessionKey);
  if (activeRow?.model) {
    return resolvePreferredServerChatModelValue(activeRow.model, activeRow.modelProvider, catalog);
  }
  return defaultModel;
}

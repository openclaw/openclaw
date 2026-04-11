import type { GatewayBrowserClient } from "../gateway.ts";
import type { CommandCatalogResult } from "../types.ts";
import {
  formatMissingOperatorReadScopeMessage,
  isMissingOperatorReadScopeError,
} from "./scope-errors.ts";

export type ChatCommandCatalogState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  chatCommandCatalogLoading: boolean;
  chatCommandCatalogLoadingAgentId: string | null;
  chatCommandCatalogRequestId: number;
  chatCommandCatalogError: string | null;
  chatCommandCatalogResult: CommandCatalogResult | null;
};

export async function loadChatCommandCatalog(state: ChatCommandCatalogState, agentId: string) {
  const resolvedAgentId = agentId.trim();
  if (
    !state.client ||
    !state.connected ||
    !resolvedAgentId ||
    (state.chatCommandCatalogLoading && state.chatCommandCatalogLoadingAgentId === resolvedAgentId)
  ) {
    return;
  }
  const requestId = state.chatCommandCatalogRequestId + 1;
  const shouldIgnoreResponse = () => state.chatCommandCatalogRequestId !== requestId;
  state.chatCommandCatalogRequestId = requestId;
  state.chatCommandCatalogLoading = true;
  state.chatCommandCatalogLoadingAgentId = resolvedAgentId;
  state.chatCommandCatalogError = null;
  state.chatCommandCatalogResult = null;
  try {
    const res = await state.client.request<CommandCatalogResult>("commands.list", {
      agentId: resolvedAgentId,
      scope: "text",
      includeArgs: true,
    });
    if (shouldIgnoreResponse()) {
      return;
    }
    state.chatCommandCatalogResult = res;
  } catch (err) {
    if (shouldIgnoreResponse()) {
      return;
    }
    state.chatCommandCatalogError = isMissingOperatorReadScopeError(err)
      ? formatMissingOperatorReadScopeMessage("chat command catalog")
      : String(err);
  } finally {
    if (state.chatCommandCatalogRequestId === requestId) {
      state.chatCommandCatalogLoadingAgentId = null;
      state.chatCommandCatalogLoading = false;
    }
  }
}

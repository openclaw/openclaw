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
  chatCommandCatalogAgentId: string | null;
  chatCommandCatalogRequestId: number;
  chatCommandCatalogError: string | null;
  chatCommandCatalogResult: CommandCatalogResult | null;
};

export async function loadChatCommandCatalog(
  state: ChatCommandCatalogState,
  agentId: string,
  opts?: { force?: boolean },
) {
  const resolvedAgentId = agentId.trim();
  const hasCurrentAgentCatalog =
    state.chatCommandCatalogAgentId === resolvedAgentId && state.chatCommandCatalogResult !== null;
  const sameAgentRequestInFlight =
    state.chatCommandCatalogLoading && state.chatCommandCatalogLoadingAgentId === resolvedAgentId;
  if (
    !state.client ||
    !state.connected ||
    !resolvedAgentId ||
    (!opts?.force && (hasCurrentAgentCatalog || sameAgentRequestInFlight))
  ) {
    return;
  }
  const requestId = state.chatCommandCatalogRequestId + 1;
  const shouldIgnoreResponse = () => state.chatCommandCatalogRequestId !== requestId;
  state.chatCommandCatalogRequestId = requestId;
  state.chatCommandCatalogLoading = true;
  state.chatCommandCatalogLoadingAgentId = resolvedAgentId;
  state.chatCommandCatalogError = null;
  if (state.chatCommandCatalogAgentId !== resolvedAgentId) {
    state.chatCommandCatalogAgentId = null;
    state.chatCommandCatalogResult = null;
  }
  try {
    const res = await state.client.request<CommandCatalogResult>("commands.list", {
      agentId: resolvedAgentId,
      scope: "text",
      includeArgs: true,
    });
    if (shouldIgnoreResponse()) {
      return;
    }
    state.chatCommandCatalogAgentId = resolvedAgentId;
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

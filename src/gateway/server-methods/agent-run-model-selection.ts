import { resolveProviderIdForAuth } from "../../agents/provider-auth-aliases.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { updateChatRunProvider } from "../chat-abort.js";
import type { GatewayContextResolver } from "./types.js";

export function createAgentRunModelSelectionHandler(params: {
  runId: string;
  resolveGatewayContext?: GatewayContextResolver;
  cfg: OpenClawConfig;
  cfgForAgent?: OpenClawConfig;
  trustedInternalHandoff?: { provider: string; model: string };
}): (selection: { provider: string; model: string }) => void {
  return ({ provider, model }) => {
    if (params.trustedInternalHandoff) {
      // The one-use grant remains tied to this run while its active model falls back.
      params.trustedInternalHandoff.provider = provider.trim().toLowerCase();
      params.trustedInternalHandoff.model = model.trim();
    }
    updateChatRunProvider({
      runId: params.runId,
      resolveGatewayContext: params.resolveGatewayContext,
      providerId: provider,
      authProviderId: resolveProviderIdForAuth(provider, {
        config: params.cfgForAgent ?? params.cfg,
      }),
    });
  };
}

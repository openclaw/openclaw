import { validateModelsAuthRefreshParams } from "../../../packages/gateway-protocol/src/index.js";
import { tryResolveAmbientOwnerAgentId } from "../../agents/agent-scope-config.js";
import { clearRuntimeAuthProfileStoreSnapshots } from "../../agents/auth-profiles/runtime-snapshots.js";
import { refreshModelAuthStateAfterMutation } from "../model-auth-refresh.js";
import { resolveModelAuthAgentScope } from "./model-auth-agent-scope.js";
import { respondUnavailableOnThrow } from "./response.js";
import type { GatewayRequestHandlers } from "./types.js";
import { defineValidatedGatewayHandler } from "./validation.js";

export const modelsAuthRefreshHandlers: GatewayRequestHandlers = {
  "models.authRefresh": defineValidatedGatewayHandler(
    "models.authRefresh",
    validateModelsAuthRefreshParams,
    async ({ params, respond, context }) => {
      const config = context.getRuntimeConfig();
      const scope = resolveModelAuthAgentScope(
        config,
        params.agentId === undefined || params.agentId === ""
          ? tryResolveAmbientOwnerAgentId(config)
          : params.agentId,
      );
      if (!scope.ok) {
        respond(false, undefined, scope.error);
        return;
      }
      await respondUnavailableOnThrow(respond, async () => {
        // Explicit refresh must observe persisted changes that supplied no in-process receipt.
        clearRuntimeAuthProfileStoreSnapshots();
        await refreshModelAuthStateAfterMutation(context.getRuntimeConfig, scope.agentId);
        respond(true, { refreshed: true }, undefined);
      });
    },
  ),
};

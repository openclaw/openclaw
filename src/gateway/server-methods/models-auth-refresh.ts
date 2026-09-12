import { validateModelsAuthRefreshParams } from "../../../packages/gateway-protocol/src/index.js";
import { tryResolveAmbientOwnerAgentId } from "../../agents/agent-scope-config.js";
import { refreshModelAuthStateAfterMutation } from "../model-auth-refresh.js";
import { modelAuthAgentScopeError, resolveModelAuthAgentScope } from "./model-auth-agent-scope.js";
import { respondUnavailableOnThrow } from "./response.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

export const modelsAuthRefreshHandlers: GatewayRequestHandlers = {
  "models.authRefresh": async ({ params, respond, context }) => {
    if (
      !assertValidParams(params, validateModelsAuthRefreshParams, "models.authRefresh", respond)
    ) {
      return;
    }
    const config = context.getRuntimeConfig();
    const scope = resolveModelAuthAgentScope(
      config,
      params.agentId === undefined || params.agentId === ""
        ? tryResolveAmbientOwnerAgentId(config)
        : params.agentId,
    );
    if (!scope.ok) {
      respond(false, undefined, modelAuthAgentScopeError(scope));
      return;
    }
    await respondUnavailableOnThrow(respond, async () => {
      await refreshModelAuthStateAfterMutation(
        context.getRuntimeConfig,
        params.operation,
        scope.agentId,
      );
      respond(true, { refreshed: true }, undefined);
    });
  },
};

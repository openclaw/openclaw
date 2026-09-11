import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
// Models gateway methods expose prepared, cached, and explicitly refreshed catalog views.
import {
  ErrorCodes,
  errorShape,
  validateModelsListParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { tryResolveAmbientOwnerAgentId } from "../../agents/agent-scope-config.js";
import { ModelAccountConnectAuthorityError } from "../model-account-connect.js";
import { resolveAgentIdOrRespondError } from "./agent-id-shared.js";
import { resolveChatMetadataReadParams } from "./chat-metadata-handler.js";
import { projectSessionModelCatalog } from "./chat-metadata-session-projection.js";
import { buildModelsListResult } from "./models-list-result.js";
import type { GatewayRequestHandlers } from "./types.js";
import { resolveAuthenticatedProfileId } from "./users-profile-access.js";
import { assertValidParams } from "./validation.js";
export { buildModelsListResult };

// Ordinary reads consume published facts; only an explicit refresh starts discovery.
export const modelsHandlers: GatewayRequestHandlers = {
  "models.list": async (options) => {
    const { params, respond, context, client } = options;
    if (!assertValidParams(params, validateModelsListParams, "models.list", respond)) {
      return;
    }
    try {
      const scoped = Boolean(params.sessionKey || params.authProfileId);
      const scope = scoped ? resolveChatMetadataReadParams(options, params) : undefined;
      if (scoped && !scope) {
        return;
      }
      const cfg = context.getRuntimeConfig();
      const resolved =
        scope ??
        resolveAgentIdOrRespondError({
          rawAgentId: params.agentId ?? tryResolveAmbientOwnerAgentId(cfg),
          respond,
          cfg,
          normalize: normalizeOptionalString,
        });
      if (!resolved) {
        return;
      }
      const result = await buildModelsListResult({
        source: { kind: "gateway", context },
        agentId: resolved.agentId,
        params,
        requesterProfileId: scope?.requesterProfileId ?? resolveAuthenticatedProfileId(client),
        ...(scope ? { readScope: scope } : {}),
      });
      scope?.draftAccountSelection?.assertCurrent();
      respond(
        true,
        scope && params.view !== "provider-config"
          ? {
              ...result,
              models: projectSessionModelCatalog(scope, result.models, context.getRuntimeConfig()),
            }
          : result,
        undefined,
      );
    } catch (error) {
      if (!(error instanceof ModelAccountConnectAuthorityError)) {
        throw error;
      }
      respond(false, undefined, errorShape(ErrorCodes.FORBIDDEN, error.message));
    }
  },
};

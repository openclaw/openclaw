import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  GATEWAY_CLIENT_CAPS,
  hasGatewayClientCap,
} from "../../../packages/gateway-protocol/src/client-info.js";
// Models gateway methods expose prepared, cached, and explicitly refreshed catalog views.
import {
  ErrorCodes,
  errorShape,
  validateModelsListParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { tryResolveAmbientOwnerAgentId } from "../../agents/agent-scope-config.js";
import { PreparedModelRuntimePublicationSupersededError } from "../../agents/prepared-model-runtime.errors.js";
import { ModelAccountConnectAuthorityError } from "../model-account-connect.js";
import { resolveAgentIdOrRespondError } from "./agent-id-shared.js";
import type { ChatMetadataReadParams } from "./chat-metadata-contract.js";
import { resolveChatMetadataReadParams } from "./chat-metadata-handler.js";
import { projectSessionModelCatalog } from "./chat-metadata-session-projection.js";
import { buildModelsListResult } from "./models-list-result.js";
import type { GatewayRequestHandlers } from "./types.js";
import { resolveAuthenticatedProfileId } from "./users-profile-access.js";
import { assertValidParams } from "./validation.js";
export { buildModelsListResult };

// Ordinary reads return saved rows while expired provider inventory refreshes in the background.
export const modelsHandlers: GatewayRequestHandlers = {
  "models.list": async (options) => {
    const { params, respond, context, client } = options;
    if (!assertValidParams(params, validateModelsListParams, "models.list", respond)) {
      return;
    }
    let scope: ChatMetadataReadParams | undefined;
    try {
      const scoped = Boolean(params.sessionKey || params.authProfileId);
      scope = scoped ? resolveChatMetadataReadParams(options, params) : undefined;
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
        includeManualSelection: hasGatewayClientCap(
          client?.connect.caps,
          GATEWAY_CLIENT_CAPS.MODEL_SELECTION_POLICY,
        ),
        requesterProfileId: scope?.requesterProfileId ?? resolveAuthenticatedProfileId(client),
        ...(scope ? { readScope: scope } : {}),
      });
      scope?.draftAccountSelection?.assertCurrent();
      scope?.assertCurrent?.();
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
      if (error instanceof PreparedModelRuntimePublicationSupersededError) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, error.message, { retryable: true, retryAfterMs: 0 }),
        );
        return;
      }
      if (!(error instanceof ModelAccountConnectAuthorityError)) {
        throw error;
      }
      respond(false, undefined, errorShape(ErrorCodes.FORBIDDEN, error.message));
    } finally {
      scope?.release?.();
    }
  },
};

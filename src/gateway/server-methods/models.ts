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
import { refreshExpiredPreparedModelCatalog } from "../../agents/prepared-model-catalog.js";
import { PreparedModelRuntimePublicationSupersededError } from "../../agents/prepared-model-runtime.errors.js";
import { roleScopesAllow } from "../../shared/operator-scope-compat.js";
import { ModelAccountConnectAuthorityError } from "../model-account-connect.js";
import { prepareOperatorModelPresentation } from "../operator-model-presentation.js";
import { authorizeCurrentOperatorRoleScopes } from "../operator-role-policy.js";
import { READ_SCOPE, SESSION_READ_SCOPE } from "../operator-scopes.js";
import { SessionMutationAuthorizationChangedError } from "../session-mutation-authorization-error.js";
import { resolveAgentIdOrRespondError } from "./agent-id-shared.js";
import type { ChatMetadataReadParams } from "./chat-metadata-contract.js";
import { resolveChatMetadataReadParams } from "./chat-metadata-handler.js";
import { projectSessionModelCatalog } from "./chat-metadata-session-projection.js";
import { buildModelsListResult } from "./models-list-result.js";
import type { GatewayRequestHandlers } from "./types.js";
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
    let publicationScope: ChatMetadataReadParams | undefined;
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
      if (!scope) {
        const roleError = authorizeCurrentOperatorRoleScopes(client, cfg);
        if (roleError) {
          respond(false, undefined, roleError);
          return;
        }
        const scopes = client?.connect.scopes ?? [];
        const limitedSessionRead =
          roleScopesAllow({
            role: "operator",
            requestedScopes: [SESSION_READ_SCOPE],
            allowedScopes: scopes,
          }) &&
          !roleScopesAllow({
            role: "operator",
            requestedScopes: [READ_SCOPE],
            allowedScopes: scopes,
          });
        if (limitedSessionRead) {
          scope = resolveChatMetadataReadParams(options, { agentId: resolved.agentId });
          if (!scope) {
            return;
          }
        }
      }
      publicationScope =
        scope ?? resolveChatMetadataReadParams(options, { agentId: resolved.agentId });
      if (!publicationScope) {
        return;
      }
      if (params.refresh !== true) {
        refreshExpiredPreparedModelCatalog({ agentId: resolved.agentId, config: cfg });
      }
      const result = await buildModelsListResult({
        source: { kind: "gateway", context },
        agentId: resolved.agentId,
        params,
        includeManualSelection: hasGatewayClientCap(
          client?.connect.caps,
          GATEWAY_CLIENT_CAPS.MODEL_SELECTION_POLICY,
        ),
        requesterProfileId: publicationScope.requesterProfileId,
        ...(scope ? { readScope: scope } : {}),
      });
      publicationScope.draftAccountSelection?.assertCurrent();
      publicationScope.assertCurrent?.();
      const currentConfig = context.getRuntimeConfig();
      const projected =
        scope && params.view !== "provider-config"
          ? {
              ...result,
              models: projectSessionModelCatalog(scope, result.models, currentConfig),
            }
          : result;
      const policy = prepareOperatorModelPresentation({
        cfg: currentConfig,
        policyConfig: context.getCommittedRuntimeConfig?.() ?? currentConfig,
        client,
      })?.forAgent(resolved.agentId, projected.models);
      respond(true, policy ? policy.catalog(projected) : projected, undefined);
    } catch (error) {
      if (error instanceof SessionMutationAuthorizationChangedError) {
        respond(false, undefined, error.error);
        return;
      }
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
      (publicationScope ?? scope)?.release?.();
    }
  },
};

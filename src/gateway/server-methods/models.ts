import {
  GATEWAY_CLIENT_CAPS,
  hasGatewayClientCap,
} from "../../../packages/gateway-protocol/src/client-info.js";
import {
  ErrorCodes,
  errorShape,
  validateModelsListParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { tryResolveAmbientOwnerAgentId } from "../../agents/agent-scope-config.js";
import { refreshExpiredPreparedModelCatalog } from "../../agents/prepared-model-catalog.js";
import { PreparedModelRuntimePublicationSupersededError } from "../../agents/prepared-model-runtime.errors.js";
import { applyRemoteModelCatalogUpdate } from "../../agents/prepared-model-runtime.js";
import { roleScopesAllow } from "../../shared/operator-scope-compat.js";
import { ModelAccountConnectAuthorityError } from "../model-account-connect-errors.js";
import { prepareOperatorModelPresentation } from "../operator-model-presentation.js";
import { authorizeCurrentOperatorRoleScopes } from "../operator-role-policy.js";
import { READ_SCOPE, SESSION_READ_SCOPE } from "../operator-scopes.js";
import { projectModelFastModeCatalog } from "../session-fast-mode-presentation.js";
import { SessionMutationAuthorizationChangedError } from "../session-mutation-authorization-error.js";
import { resolveAgentIdOrRespondError } from "./agent-id-shared.js";
import type { ChatMetadataReadParams } from "./chat-metadata-contract.js";
import { resolveChatMetadataReadParams } from "./chat-metadata-handler.js";
import { projectSessionModelCatalog } from "./chat-metadata-session-projection.js";
import { UnknownModelCatalogProviderError } from "./models-list-capabilities.js";
import { buildModelsListResult } from "./models-list-result.js";
import { createPreparedReadHandler } from "./prepared-read.js";
import type { GatewayRequestHandlers } from "./types.js";
import { preparePersonalModelAccountSelection } from "./users-model-account-access.js";
import { assertValidParams } from "./validation.js";

// Ordinary reads return saved rows while expired provider inventory refreshes in the background.
export const modelsHandlers: GatewayRequestHandlers = {
  "models.list": createPreparedReadHandler(
    async (options) => {
      const { params, respond: respondToCaller, context, client } = options;
      if (!assertValidParams(params, validateModelsListParams, "models.list", respondToCaller)) {
        return undefined;
      }
      let scope: ChatMetadataReadParams | undefined;
      let publicationScope: ChatMetadataReadParams | undefined;
      try {
        const scoped = Boolean(params.sessionKey || params.authProfileId);
        const draftAccountSelection =
          !params.sessionKey && params.authProfileId
            ? await preparePersonalModelAccountSelection(
                options,
                params.authProfileId,
                SESSION_READ_SCOPE,
              )
            : undefined;
        scope = scoped
          ? await resolveChatMetadataReadParams(options, params, draftAccountSelection)
          : undefined;
        if (scoped && !scope) {
          return undefined;
        }
        const cfg = context.getRuntimeConfig();
        const resolved =
          scope ??
          resolveAgentIdOrRespondError({
            rawAgentId: params.agentId ?? tryResolveAmbientOwnerAgentId(cfg),
            respond: respondToCaller,
            cfg,
          });
        if (!resolved) {
          return undefined;
        }
        if (!scope) {
          const roleError = authorizeCurrentOperatorRoleScopes(client, cfg);
          if (roleError) {
            respondToCaller(false, undefined, roleError);
            return undefined;
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
            scope = await resolveChatMetadataReadParams(options, { agentId: resolved.agentId });
            if (!scope) {
              return undefined;
            }
          }
        }
        publicationScope =
          scope ?? (await resolveChatMetadataReadParams(options, { agentId: resolved.agentId }));
        if (!publicationScope) {
          return undefined;
        }
        const preparedScope = publicationScope;
        const assertCurrent = () => {
          preparedScope.draftAccountSelection?.assertCurrent();
          preparedScope.assertCurrent?.();
        };
        assertCurrent();
        if (params.refresh !== true) {
          refreshExpiredPreparedModelCatalog({ agentId: resolved.agentId, config: cfg });
        }
        return {
          assertCurrent,
          release: preparedScope.release,
          run: async (respond) => {
            const includeManualSelection = hasGatewayClientCap(
              client?.connect.caps,
              GATEWAY_CLIENT_CAPS.MODEL_SELECTION_POLICY,
            );
            const prepared =
              !scope && params.refresh !== true
                ? await context.readPreparedModelsList?.({
                    agentId: resolved.agentId,
                    params,
                    includeManualSelection,
                    requesterProfileId: preparedScope.requesterProfileId,
                  })
                : undefined;
            const result =
              prepared ??
              (await buildModelsListResult({
                source: { kind: "gateway", context },
                agentId: resolved.agentId,
                params,
                includeManualSelection,
                requesterProfileId: preparedScope.requesterProfileId,
                readScope: scope,
                publicationScope: preparedScope,
              }));
            const publish = () => {
              assertCurrent();
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
              respond(
                true,
                projectModelFastModeCatalog(policy ? policy.catalog(projected) : projected, client),
                undefined,
              );
            };
            if (preparedScope.withCurrent) {
              await preparedScope.withCurrent(publish);
            } else {
              publish();
            }
            if (params.refresh === true) {
              void Promise.resolve()
                .then(() => applyRemoteModelCatalogUpdate(context.getRuntimeConfig))
                .catch((error: unknown) => {
                  context.logGateway.warn("remote model catalog adoption failed", {
                    error: String(error),
                  });
                });
            }
          },
        };
      } catch (error) {
        (publicationScope ?? scope)?.release?.();
        throw error;
      }
    },
    (error, { respond }) => {
      if (error instanceof UnknownModelCatalogProviderError) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, error.message));
        return;
      }
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
    },
  ),
};

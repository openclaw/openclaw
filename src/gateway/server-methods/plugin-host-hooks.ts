import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  formatValidationErrors,
  missingScopeErrorShape,
  validatePluginsSessionActionParams,
  validatePluginsSessionActionResult,
  validatePluginsUiDescriptorsParams,
  type PluginsUiDescriptorsResult,
} from "../../../packages/gateway-protocol/src/index.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { isPluginJsonValue } from "../../plugins/host-hooks.js";
import { isPluginReloadingError } from "../../plugins/plugin-replacement-retry.js";
import { getPluginRegistryVersion } from "../../plugins/runtime-state.js";
import { getPluginRegistryForContext } from "../../plugins/runtime/gateway-request-scope.js";
import { validateJsonSchemaValue, type JsonSchemaValue } from "../../plugins/schema-validator.js";
import { hasMultipleResidentSessionSharingIdentities } from "../../state/user-profile-list.js";
import {
  listControlUiPluginDescriptors,
  listControlUiLinkReaders,
  listControlUiPluginTabs,
  listControlUiPluginWidgetKinds,
} from "../control-ui-plugin-tabs.js";
import { authorizeOperatorScopesForRequiredScope } from "../method-scopes.js";
import { resolveOperatorRoleAgents } from "../operator-role-policy.js";
import { WRITE_SCOPE } from "../operator-scopes.js";
import { resolveRequestedSessionAgentId } from "../session-request-agent.js";
import { resolveStoredSessionKeyForAgentStore } from "../session-store-key.js";
import { respondError } from "./response.js";
import { readGatewayRequestMutationAuthority } from "./session-mutation-guards.js";
import type { GatewayRequestHandlers } from "./types.js";
import { defineValidatedGatewayHandler } from "./validation.js";

const log = createSubsystemLogger("gateway/plugin-host-hooks");

export const pluginHostHookHandlers: GatewayRequestHandlers = {
  "plugins.uiDescriptors": defineValidatedGatewayHandler(
    "plugins.uiDescriptors",
    validatePluginsUiDescriptorsParams,
    ({ respond, client, context }) => {
      const methods = context.getGatewayMethodRegistry?.();
      if (!methods) {
        respondError(
          respond,
          ErrorCodes.UNAVAILABLE,
          "Gateway plugin capabilities are unavailable in this runtime.",
        );
        return;
      }
      const scopes = client?.connect.scopes ?? [];
      const result: PluginsUiDescriptorsResult = {
        ok: true,
        generation: getPluginRegistryVersion(getPluginRegistryForContext()),
        descriptors: listControlUiPluginDescriptors(scopes),
        methods: methods.listAdvertisedMethods(),
        controlUiTabs: listControlUiPluginTabs(scopes, {
          requireGatewayAuthGrant: context.getRuntimeConfig().gateway?.auth?.mode !== "none",
        }),
        controlUiWidgetKinds: listControlUiPluginWidgetKinds(scopes),
        controlUiLinkReaders: listControlUiLinkReaders(scopes, methods),
        pluginSurfaceUrls: client?.pluginSurfaceUrls ?? {},
      };
      respond(true, result, undefined);
    },
  ),
  "plugins.sessionAction": defineValidatedGatewayHandler(
    "plugins.sessionAction",
    validatePluginsSessionActionParams,
    async (options) => {
      const { params, client, respond, context } = options;
      // A reload can refuse the selected action between quiesce and publish. Wait
      // for it once, then select and authorize again from the current registry.
      const dispatch = async (afterReplacement: boolean): Promise<void> => {
        const reject = (message: string) =>
          respondError(respond, ErrorCodes.INVALID_REQUEST, message);
        const pluginId = normalizeOptionalString(params.pluginId);
        const actionId = normalizeOptionalString(params.actionId);
        const rawSessionKey = normalizeOptionalString(params.sessionKey);
        const sessionOwner = rawSessionKey
          ? resolveRequestedSessionAgentId(
              context.getRuntimeConfig(),
              rawSessionKey,
              normalizeOptionalString(params.agentId),
            )
          : undefined;
        if (sessionOwner && !sessionOwner.ok) {
          respond(false, undefined, sessionOwner.error);
          return;
        }
        const sessionKey =
          rawSessionKey && sessionOwner?.ok
            ? resolveStoredSessionKeyForAgentStore({
                cfg: context.getRuntimeConfig(),
                agentId: sessionOwner.agentId,
                sessionKey: rawSessionKey,
              })
            : undefined;
        if (!pluginId || !actionId) {
          reject("plugins.sessionAction pluginId and actionId must be non-empty");
          return;
        }
        // Requests are pinned to their admitted registry; after waiting out a reload,
        // select from the live attached registry the reload published or restored.
        const registry =
          (afterReplacement ? context.getGatewayMethodRegistry?.()?.pluginRegistry : undefined) ??
          getPluginRegistryForContext();
        const pluginLoaded = Boolean(
          registry?.plugins.some((plugin) => plugin.id === pluginId && plugin.status === "loaded"),
        );
        const registration = (registry?.sessionActions ?? []).find(
          (entry) => entry.pluginId === pluginId && entry.action.id === actionId,
        );
        if (!registration || !pluginLoaded) {
          respondError(
            respond,
            ErrorCodes.UNAVAILABLE,
            `unknown plugin session action: ${pluginId}/${actionId}`,
          );
          return;
        }
        const scopes = Array.isArray(client?.connect.scopes) ? client.connect.scopes : [];
        const requiredScopes =
          registration.action.requiredScopes && registration.action.requiredScopes.length > 0
            ? registration.action.requiredScopes
            : [WRITE_SCOPE];
        // Recheck the selected registration after async router admission, using the same
        // scope implications so the two authorization gates cannot diverge.
        const missingScope = requiredScopes.find(
          (scope) => !authorizeOperatorScopesForRequiredScope(scope, scopes).allowed,
        );
        if (missingScope) {
          respond(false, undefined, missingScopeErrorShape({ missingScope, requiredScopes }));
          return;
        }
        try {
          if (params.payload !== undefined && !isPluginJsonValue(params.payload)) {
            reject("plugin session action payload must be JSON-compatible");
            return;
          }
          if (registration.action.schema !== undefined) {
            const validation = validateJsonSchemaValue({
              schema: registration.action.schema as JsonSchemaValue,
              cacheKey: `plugin-session-action:${pluginId}:${actionId}`,
              value: params.payload,
            });
            if (!validation.ok) {
              reject(
                `plugin session action payload does not match schema: ${validation.errors.map((error) => error.text).join("; ")}`,
              );
              return;
            }
          }
          const result = await registration.action.handler({
            pluginId,
            actionId,
            ...(sessionKey ? { sessionKey } : {}),
            ...(sessionOwner?.ok ? { agentId: sessionOwner.agentId } : {}),
            ...(params.payload !== undefined ? { payload: params.payload } : {}),
            client: {
              ...(client?.connId ? { connId: client.connId } : {}),
              scopes: [...scopes],
              // Live policy, not snapshots: role config and the profile roster can
              // change while an awaited action runs, and handlers check right before effects.
              allowsAgent: (agentId: string) => {
                const roleAgents = resolveOperatorRoleAgents(
                  client ?? null,
                  context.getRuntimeConfig(),
                );
                return !roleAgents || roleAgents.includes(agentId);
              },
              isSharedGateway: () => hasMultipleResidentSessionSharingIdentities(),
              assertCurrent: () => readGatewayRequestMutationAuthority(options).assertCurrent(),
            },
          });
          if (result !== undefined && !isRecord(result)) {
            reject("plugin session action result must be an object");
            return;
          }
          const wireResult = result?.ok === false ? result : { ok: true as const, ...result };
          if (!validatePluginsSessionActionResult(wireResult)) {
            reject(
              `invalid plugin session action result: ${formatValidationErrors(validatePluginsSessionActionResult.errors)}`,
            );
            return;
          }
          const jsonResult: Record<string, unknown> | undefined = result || undefined;
          const invalidJsonField =
            jsonResult &&
            ["result", "reply", "details"].find(
              (field) => jsonResult[field] !== undefined && !isPluginJsonValue(jsonResult[field]),
            );
          if (invalidJsonField) {
            reject(`plugin session action ${invalidJsonField} must be JSON-compatible`);
            return;
          }
          if (!wireResult.ok) {
            // Plugin failures are successful RPCs with ok:false; transport errors
            // are reserved for invalid protocol data or failed dispatch.
            respond(
              true,
              {
                ok: false,
                error: wireResult.error,
                ...(wireResult.code !== undefined ? { code: wireResult.code } : {}),
                ...(wireResult.details !== undefined ? { details: wireResult.details } : {}),
              },
              undefined,
            );
            return;
          }
          respond(true, {
            ok: true,
            ...(wireResult.result !== undefined ? { result: wireResult.result } : {}),
            ...(wireResult.continueAgent !== undefined
              ? { continueAgent: wireResult.continueAgent }
              : {}),
            ...(wireResult.reply !== undefined ? { reply: wireResult.reply } : {}),
          });
        } catch (error) {
          if (isPluginReloadingError(error)) {
            if (!afterReplacement) {
              await error.replacement;
              return dispatch(true);
            }
            respondError(respond, ErrorCodes.UNAVAILABLE, `plugin ${pluginId} is reloading`, {
              retryable: true,
              details: { reason: "plugin-reloading" },
            });
            return;
          }
          log.warn(
            `plugin session action failed plugin=${pluginId} action=${actionId}: ${formatErrorMessage(error)}`,
          );
          respondError(respond, ErrorCodes.UNAVAILABLE, "plugin session action failed");
        }
      };
      await dispatch(false);
    },
  ),
};

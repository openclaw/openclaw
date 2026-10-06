import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  missingScopeErrorShape,
  validatePluginsSessionActionParams,
  validatePluginsSessionActionResult,
  validatePluginsUiDescriptorsParams,
  validatePluginsUiDescriptorsResult,
} from "../../../packages/gateway-protocol/src/index.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { isPluginJsonValue } from "../../plugins/host-hooks.js";
import { getPluginRegistryVersion } from "../../plugins/runtime-state.js";
import { getPluginRegistryForContext } from "../../plugins/runtime/gateway-request-scope.js";
import { validateJsonSchemaValue, type JsonSchemaValue } from "../../plugins/schema-validator.js";
import {
  listControlUiPluginDescriptors,
  listControlUiLinkReaders,
  listControlUiPluginTabs,
  listControlUiPluginWidgetKinds,
} from "../control-ui-plugin-tabs.js";
import { authorizeOperatorScopesForRequiredScope } from "../method-scopes.js";
import { WRITE_SCOPE } from "../operator-scopes.js";
import { resolveRequestedSessionAgentId } from "../session-request-agent.js";
import { resolveStoredSessionKeyForAgentStore } from "../session-store-key.js";
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
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.UNAVAILABLE,
            "Gateway plugin capabilities are unavailable in this runtime.",
          ),
        );
        return;
      }
      const scopes = client?.connect.scopes ?? [];
      const result = {
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
      if (!validatePluginsUiDescriptorsResult(result)) {
        log.warn("invalid plugins.uiDescriptors result", {
          errors: validatePluginsUiDescriptorsResult.errors,
        });
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.UNAVAILABLE,
            `invalid plugins.uiDescriptors result: ${formatValidationErrors(validatePluginsUiDescriptorsResult.errors)}`,
          ),
        );
        return;
      }
      respond(true, result, undefined);
    },
  ),
  "plugins.sessionAction": defineValidatedGatewayHandler(
    "plugins.sessionAction",
    validatePluginsSessionActionParams,
    async ({ params, client, respond, context }) => {
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
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            "plugins.sessionAction pluginId and actionId must be non-empty",
          ),
        );
        return;
      }
      const registry = getPluginRegistryForContext();
      const pluginLoaded = Boolean(
        registry?.plugins.some((plugin) => plugin.id === pluginId && plugin.status === "loaded"),
      );
      const registration = (registry?.sessionActions ?? []).find(
        (entry) => entry.pluginId === pluginId && entry.action.id === actionId,
      );
      if (!registration || !pluginLoaded) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.UNAVAILABLE,
            `unknown plugin session action: ${pluginId}/${actionId}`,
          ),
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
          respond(
            false,
            undefined,
            errorShape(
              ErrorCodes.INVALID_REQUEST,
              "plugin session action payload must be JSON-compatible",
            ),
          );
          return;
        }
        if (registration.action.schema !== undefined) {
          if (
            typeof registration.action.schema !== "boolean" &&
            !isRecord(registration.action.schema)
          ) {
            respond(
              false,
              undefined,
              errorShape(
                ErrorCodes.INVALID_REQUEST,
                "plugin session action schema must be an object or boolean",
              ),
            );
            return;
          }
          // Schemas are plugin-provided data; validate their shape before passing
          // them into the shared schema evaluator so malformed plugins fail cleanly.
          const validation = validateJsonSchemaValue({
            schema: registration.action.schema as JsonSchemaValue,
            cacheKey: `plugin-session-action:${pluginId}:${actionId}`,
            value: params.payload,
          });
          if (!validation.ok) {
            respond(
              false,
              undefined,
              errorShape(
                ErrorCodes.INVALID_REQUEST,
                `plugin session action payload does not match schema: ${validation.errors.map((error) => error.text).join("; ")}`,
              ),
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
          },
        });
        if (result !== undefined && !isRecord(result)) {
          respond(
            false,
            undefined,
            errorShape(
              ErrorCodes.INVALID_REQUEST,
              "plugin session action result must be an object",
            ),
          );
          return;
        }
        const wireResult = result?.ok === false ? result : { ok: true as const, ...result };
        if (!validatePluginsSessionActionResult(wireResult)) {
          respond(
            false,
            undefined,
            errorShape(
              ErrorCodes.INVALID_REQUEST,
              `invalid plugin session action result: ${formatValidationErrors(validatePluginsSessionActionResult.errors)}`,
            ),
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
          respond(
            false,
            undefined,
            errorShape(
              ErrorCodes.INVALID_REQUEST,
              `plugin session action ${invalidJsonField} must be JSON-compatible`,
            ),
          );
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
        log.warn(
          `plugin session action failed plugin=${pluginId} action=${actionId}: ${formatErrorMessage(error)}`,
        );
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, "plugin session action failed"),
        );
      }
    },
  ),
};

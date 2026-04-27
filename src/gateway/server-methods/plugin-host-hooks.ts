import { isPluginJsonValue } from "../../plugins/host-hooks.js";
import { getActivePluginRegistry } from "../../plugins/runtime.js";
import { ADMIN_SCOPE } from "../operator-scopes.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validatePluginsSessionActionParams,
  validatePluginsUiDescriptorsParams,
} from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

export const pluginHostHookHandlers: GatewayRequestHandlers = {
  "plugins.uiDescriptors": ({ params, respond }) => {
    if (!validatePluginsUiDescriptorsParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid plugins.uiDescriptors params: ${formatValidationErrors(validatePluginsUiDescriptorsParams.errors)}`,
        ),
      );
      return;
    }
    const descriptors = (getActivePluginRegistry()?.controlUiDescriptors ?? []).map((entry) =>
      Object.assign({}, entry.descriptor, {
        pluginId: entry.pluginId,
        pluginName: entry.pluginName,
      }),
    );
    respond(true, { ok: true, descriptors }, undefined);
  },
  "plugins.sessionAction": async ({ params, client, respond }) => {
    if (!validatePluginsSessionActionParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid plugins.sessionAction params: ${formatValidationErrors(validatePluginsSessionActionParams.errors)}`,
        ),
      );
      return;
    }
    const pluginId = params.pluginId.trim();
    const actionId = params.actionId.trim();
    const registration = (getActivePluginRegistry()?.sessionActions ?? []).find(
      (entry) => entry.pluginId === pluginId && entry.action.id === actionId,
    );
    if (!registration) {
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
    const hasAdmin = scopes.includes(ADMIN_SCOPE);
    const missingScope = (registration.action.requiredScopes ?? []).find(
      (scope) => !hasAdmin && !scopes.includes(scope),
    );
    if (missingScope) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `plugin session action requires gateway scope: ${missingScope}`,
        ),
      );
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
      const result = await registration.action.handler({
        pluginId,
        actionId,
        ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
        ...(params.payload !== undefined ? { payload: params.payload } : {}),
        client: {
          ...(client?.connId ? { connId: client.connId } : {}),
          scopes,
        },
      });
      if (result && "ok" in result && result.ok === false) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, result.error, {
            details:
              result.code !== undefined
                ? { code: result.code, details: result.details }
                : result.details,
          }),
        );
        return;
      }
      const success = result;
      if (success?.data !== undefined && !isPluginJsonValue(success.data)) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            "plugin session action result must be JSON-compatible",
          ),
        );
        return;
      }
      if (success?.reply !== undefined && !isPluginJsonValue(success.reply)) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            "plugin session action reply must be JSON-compatible",
          ),
        );
        return;
      }
      respond(true, {
        ok: true,
        ...(success?.data !== undefined ? { result: success.data } : {}),
        ...(success?.continueAgent !== undefined ? { continueAgent: success.continueAgent } : {}),
        ...(success?.reply !== undefined ? { reply: success.reply } : {}),
      });
    } catch (error) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, `plugin session action failed: ${String(error)}`),
      );
    }
  },
};

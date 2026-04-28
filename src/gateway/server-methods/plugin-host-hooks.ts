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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

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
      if (result !== undefined && !isRecord(result)) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "plugin session action result must be an object"),
        );
        return;
      }
      if (result?.ok !== undefined && typeof result.ok !== "boolean") {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "plugin session action ok must be a boolean"),
        );
        return;
      }
      if (result && result.ok === false) {
        if (typeof result.error !== "string" || !result.error.trim()) {
          respond(
            false,
            undefined,
            errorShape(
              ErrorCodes.INVALID_REQUEST,
              "plugin session action error must be a non-empty string",
            ),
          );
          return;
        }
        if (result.code !== undefined && typeof result.code !== "string") {
          respond(
            false,
            undefined,
            errorShape(
              ErrorCodes.INVALID_REQUEST,
              "plugin session action error code must be a string",
            ),
          );
          return;
        }
        if (result.details !== undefined && !isPluginJsonValue(result.details)) {
          respond(
            false,
            undefined,
            errorShape(
              ErrorCodes.INVALID_REQUEST,
              "plugin session action error details must be JSON-compatible",
            ),
          );
          return;
        }
        // Plugin-declared action failures are returned as a successful RPC
        // with `ok: false` per PluginsSessionActionResultSchema. Reserve
        // transport errorShape for protocol-level failures (validation,
        // schema mismatch, dispatch error). Distinguishing these in the
        // wire shape lets callers handle plugin failures (often retryable
        // or user-facing) differently from transport errors (operator
        // diagnostics).
        respond(
          true,
          {
            ok: false,
            error: result.error,
            ...(result.code !== undefined ? { code: result.code } : {}),
            ...(result.details !== undefined ? { details: result.details } : {}),
          },
          undefined,
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
      if (success?.continueAgent !== undefined && typeof success.continueAgent !== "boolean") {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            "plugin session action continueAgent must be a boolean",
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

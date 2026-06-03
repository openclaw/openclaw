import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validatePluginsSessionActionParams,
  validatePluginsSessionActionResult,
  validatePluginsUiDescriptorsParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { isPluginJsonValue } from "../../plugins/host-hooks.js";
import type {
  PluginRegistry,
  PluginSessionActionRegistryRegistration,
} from "../../plugins/registry-types.js";
import { getActivePluginRegistry } from "../../plugins/runtime.js";
import {
  validateJsonSchemaValue,
  type JsonSchemaValidationError,
  type JsonSchemaValue,
} from "../../plugins/schema-validator.js";
import { ADMIN_SCOPE, READ_SCOPE, WRITE_SCOPE } from "../operator-scopes.js";
import type { GatewayRequestHandlers } from "./types.js";

const log = createSubsystemLogger("gateway/plugin-host-hooks");

type ReadResult<T> = { ok: true; value: T } | { ok: false };

type MatchedSessionAction = {
  action: PluginSessionActionRegistryRegistration["action"];
  handler: PluginSessionActionRegistryRegistration["action"]["handler"];
  requiredScopes: string[] | null;
  schema: PluginSessionActionRegistryRegistration["action"]["schema"];
};

function readField<T>(read: () => T): ReadResult<T> {
  try {
    return { ok: true, value: read() };
  } catch {
    return { ok: false };
  }
}

function readArrayLength(value: readonly unknown[]): number | null {
  const length = readField(() => value.length);
  return length.ok && Number.isInteger(length.value) && length.value >= 0 ? length.value : null;
}

function listSessionActionRegistrations(registry: PluginRegistry | null): readonly unknown[] {
  const entries = readField(() => registry?.sessionActions);
  return entries.ok && Array.isArray(entries.value) ? entries.value : [];
}

function readRequiredScopes(
  action: PluginSessionActionRegistryRegistration["action"],
): string[] | null {
  const requiredScopes = readField(() => action.requiredScopes);
  if (!requiredScopes.ok) {
    return null;
  }
  if (requiredScopes.value === undefined) {
    return [WRITE_SCOPE];
  }
  if (!Array.isArray(requiredScopes.value)) {
    return null;
  }
  const length = readArrayLength(requiredScopes.value);
  if (length === null) {
    return null;
  }
  const scopes: string[] = [];
  let index = 0;
  while (index < length) {
    const scope = readField(() => requiredScopes.value?.[index]);
    if (!scope.ok || typeof scope.value !== "string") {
      return null;
    }
    scopes.push(scope.value);
    index += 1;
  }
  return scopes.length > 0 ? scopes : [WRITE_SCOPE];
}

function findSessionActionRegistration(params: {
  actionId: string;
  pluginId: string;
  registry: PluginRegistry | null;
}): MatchedSessionAction | null {
  const entries = listSessionActionRegistrations(params.registry);
  const length = readArrayLength(entries);
  if (length === null) {
    return null;
  }
  let index = 0;
  while (index < length) {
    const entry = readField(() => entries[index] as PluginSessionActionRegistryRegistration);
    const pluginId: ReadResult<string> = entry.ok
      ? readField(() => entry.value.pluginId)
      : { ok: false };
    const action: ReadResult<PluginSessionActionRegistryRegistration["action"]> = entry.ok
      ? readField(() => entry.value.action)
      : { ok: false };
    const actionId: ReadResult<string> = action.ok
      ? readField(() => action.value.id)
      : { ok: false };
    if (
      pluginId.ok &&
      pluginId.value === params.pluginId &&
      action.ok &&
      actionId.ok &&
      actionId.value === params.actionId
    ) {
      const handler = readField(() => action.value.handler);
      const schema = readField(() => action.value.schema);
      return handler.ok && schema.ok
        ? {
            action: action.value,
            handler: handler.value,
            requiredScopes: readRequiredScopes(action.value),
            schema: schema.value,
          }
        : null;
    }
    index += 1;
  }
  return null;
}

function formatSessionActionPayloadSchemaErrors(errors: JsonSchemaValidationError[]): string {
  return errors.map((error) => error.text).join("; ");
}

/** Ensures plugin action result extension fields stay JSON-compatible on the wire. */
function validatePluginSessionActionJsonFields(
  result: Record<string, unknown>,
): string | undefined {
  for (const field of ["result", "reply", "details"] as const) {
    if (result[field] !== undefined && !isPluginJsonValue(result[field])) {
      return `plugin session action ${field} must be JSON-compatible`;
    }
  }
  return undefined;
}

/** Gateway handlers for plugin-declared Control UI descriptors and session actions. */
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
    const pluginId = normalizeOptionalString(params.pluginId);
    const actionId = normalizeOptionalString(params.actionId);
    const sessionKey = normalizeOptionalString(params.sessionKey);
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
    const registry = getActivePluginRegistry();
    const pluginLoaded = Boolean(
      registry?.plugins.some((plugin) => plugin.id === pluginId && plugin.status === "loaded"),
    );
    const registration = findSessionActionRegistration({ actionId, pluginId, registry });
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
    const hasAdmin = scopes.includes(ADMIN_SCOPE);
    const requiredScopes = registration.requiredScopes;
    if (!requiredScopes) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "plugin session action metadata unavailable"),
      );
      return;
    }
    // Plugin actions default to write access, while read-only actions can opt
    // down. Admin bypasses all checks and write includes read for UI callers.
    const missingScope = requiredScopes.find(
      (scope) =>
        !hasAdmin &&
        !scopes.includes(scope) &&
        !(scope === READ_SCOPE && scopes.includes(WRITE_SCOPE)),
    );
    if (missingScope) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `missing scope: ${missingScope}`),
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
      if (registration.schema !== undefined) {
        if (typeof registration.schema !== "boolean" && !isRecord(registration.schema)) {
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
          schema: registration.schema as JsonSchemaValue,
          cacheKey: `plugin-session-action:${pluginId}:${actionId}`,
          value: params.payload,
        });
        if (!validation.ok) {
          respond(
            false,
            undefined,
            errorShape(
              ErrorCodes.INVALID_REQUEST,
              `plugin session action payload does not match schema: ${formatSessionActionPayloadSchemaErrors(validation.errors)}`,
            ),
          );
          return;
        }
      }
      const result = await Reflect.apply(registration.handler, registration.action, [
        {
          pluginId,
          actionId,
          ...(sessionKey ? { sessionKey } : {}),
          ...(params.payload !== undefined ? { payload: params.payload } : {}),
          client: {
            ...(client?.connId ? { connId: client.connId } : {}),
            scopes: [...scopes],
          },
        },
      ]);
      if (result !== undefined && !isRecord(result)) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "plugin session action result must be an object"),
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
      const jsonFieldError = result ? validatePluginSessionActionJsonFields(result) : undefined;
      if (jsonFieldError) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, jsonFieldError));
        return;
      }
      if (!wireResult.ok) {
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
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "plugin session action failed"));
    }
  },
};

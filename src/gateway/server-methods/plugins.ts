import { formatErrorMessage } from "../../infra/errors.js";
import {
  doctorManagedPlugins,
  inspectManagedPlugin,
  inspectManagedPluginRegistry,
  installManagedPlugin,
  listManagedPlugins,
  refreshManagedPluginRegistry,
  setManagedPluginEnabled,
  uninstallManagedPlugin,
  updateManagedPlugins,
} from "../../plugins/management.js";
import type { PluginManagementError } from "../../plugins/management.js";
import type { PluginManagementInstallParams } from "../../plugins/management.js";
import {
  ErrorCodes,
  errorShape,
  validatePluginsDisableParams,
  validatePluginsDoctorParams,
  validatePluginsEnableParams,
  validatePluginsInspectParams,
  validatePluginsInstallParams,
  validatePluginsListParams,
  validatePluginsRegistryRefreshParams,
  validatePluginsRegistryStatusParams,
  validatePluginsUninstallParams,
  validatePluginsUpdateParams,
} from "../protocol/index.js";
import type { PluginsInstallParams } from "../protocol/index.js";
import type { GatewayRequestHandlers, RespondFn } from "./types.js";
import { assertValidParams } from "./validation.js";

function codeForServiceError(error: PluginManagementError) {
  switch (error.kind) {
    case "invalid-request":
    case "not-found":
    case "conflict":
      return ErrorCodes.INVALID_REQUEST;
    case "unavailable":
      return ErrorCodes.UNAVAILABLE;
    default: {
      const exhaustive: never = error.kind;
      return exhaustive;
    }
  }
}

function respondServiceError(respond: RespondFn, method: string, error: PluginManagementError) {
  respond(false, undefined, errorShape(codeForServiceError(error), `${method}: ${error.message}`));
}

function respondServiceException(respond: RespondFn, method: string, error: unknown) {
  respond(
    false,
    undefined,
    errorShape(ErrorCodes.UNAVAILABLE, `${method}: ${formatErrorMessage(error)}`),
  );
}

function requireInstallStringField(
  params: PluginsInstallParams,
  field: "path" | "spec",
): string | PluginManagementError {
  const value = params[field];
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  return {
    kind: "invalid-request",
    message: `plugins.install source "${params.source}" requires "${field}"`,
  };
}

function normalizePluginInstallParams(
  params: PluginsInstallParams,
): PluginManagementInstallParams | PluginManagementError {
  if (params.source === "path") {
    const path = requireInstallStringField(params, "path");
    if (typeof path !== "string") {
      return path;
    }
    return {
      source: "path",
      path,
      ...(params.force !== undefined ? { force: params.force } : {}),
      ...(params.link !== undefined ? { link: params.link } : {}),
      ...(params.dangerouslyForceUnsafeInstall !== undefined
        ? { dangerouslyForceUnsafeInstall: params.dangerouslyForceUnsafeInstall }
        : {}),
      ...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs } : {}),
    };
  }
  const spec = requireInstallStringField(params, "spec");
  if (typeof spec !== "string") {
    return spec;
  }
  if (params.source === "npm") {
    return {
      source: "npm",
      spec,
      ...(params.force !== undefined ? { force: params.force } : {}),
      ...(params.pin !== undefined ? { pin: params.pin } : {}),
      ...(params.dangerouslyForceUnsafeInstall !== undefined
        ? { dangerouslyForceUnsafeInstall: params.dangerouslyForceUnsafeInstall }
        : {}),
      ...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs } : {}),
    };
  }
  return {
    source: "clawhub",
    spec,
    ...(params.force !== undefined ? { force: params.force } : {}),
    ...(params.dangerouslyForceUnsafeInstall !== undefined
      ? { dangerouslyForceUnsafeInstall: params.dangerouslyForceUnsafeInstall }
      : {}),
    ...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs } : {}),
  };
}

async function respondPluginToggle(
  respond: RespondFn,
  method: "plugins.enable" | "plugins.disable",
  id: string,
  enabled: boolean,
) {
  const result = await setManagedPluginEnabled({ id, enabled });
  if (!result.ok) {
    respondServiceError(
      respond,
      method,
      result.error ?? {
        kind: "unavailable",
        message: `plugin ${enabled ? "enable" : "disable"} failed`,
      },
    );
    return;
  }
  respond(true, result, undefined);
}

export const pluginManagementHandlers: GatewayRequestHandlers = {
  "plugins.list": ({ params, respond }) => {
    if (!assertValidParams(params, validatePluginsListParams, "plugins.list", respond)) {
      return;
    }
    respond(true, listManagedPlugins(params), undefined);
  },
  "plugins.inspect": async ({ params, respond }) => {
    if (!assertValidParams(params, validatePluginsInspectParams, "plugins.inspect", respond)) {
      return;
    }
    try {
      const result = await inspectManagedPlugin(params.id);
      if (!result.ok) {
        respondServiceError(respond, "plugins.inspect", result.error);
        return;
      }
      respond(true, result, undefined);
    } catch (error) {
      respondServiceException(respond, "plugins.inspect", error);
    }
  },
  "plugins.doctor": ({ params, respond }) => {
    if (!assertValidParams(params, validatePluginsDoctorParams, "plugins.doctor", respond)) {
      return;
    }
    respond(true, doctorManagedPlugins(), undefined);
  },
  "plugins.registry.status": async ({ params, respond }) => {
    if (
      !assertValidParams(
        params,
        validatePluginsRegistryStatusParams,
        "plugins.registry.status",
        respond,
      )
    ) {
      return;
    }
    try {
      respond(true, await inspectManagedPluginRegistry(), undefined);
    } catch (error) {
      respondServiceException(respond, "plugins.registry.status", error);
    }
  },
  "plugins.registry.refresh": async ({ params, respond }) => {
    if (
      !assertValidParams(
        params,
        validatePluginsRegistryRefreshParams,
        "plugins.registry.refresh",
        respond,
      )
    ) {
      return;
    }
    try {
      respond(true, await refreshManagedPluginRegistry(), undefined);
    } catch (error) {
      respondServiceException(respond, "plugins.registry.refresh", error);
    }
  },
  "plugins.install": async ({ params, respond }) => {
    if (!assertValidParams(params, validatePluginsInstallParams, "plugins.install", respond)) {
      return;
    }
    try {
      const normalized = normalizePluginInstallParams(params);
      if ("kind" in normalized) {
        respondServiceError(respond, "plugins.install", normalized);
        return;
      }
      const result = await installManagedPlugin(normalized);
      if (!result.ok) {
        respondServiceError(
          respond,
          "plugins.install",
          result.error ?? { kind: "unavailable", message: "plugin install failed" },
        );
        return;
      }
      respond(true, result, undefined);
    } catch (error) {
      respondServiceException(respond, "plugins.install", error);
    }
  },
  "plugins.update": async ({ params, respond }) => {
    if (!assertValidParams(params, validatePluginsUpdateParams, "plugins.update", respond)) {
      return;
    }
    try {
      const result = await updateManagedPlugins(params);
      if (!result.ok) {
        respondServiceError(
          respond,
          "plugins.update",
          "error" in result
            ? (result.error ?? { kind: "unavailable", message: "plugin update failed" })
            : { kind: "unavailable", message: "one or more plugin updates failed" },
        );
        return;
      }
      respond(true, result, undefined);
    } catch (error) {
      respondServiceException(respond, "plugins.update", error);
    }
  },
  "plugins.uninstall": async ({ params, respond }) => {
    if (!assertValidParams(params, validatePluginsUninstallParams, "plugins.uninstall", respond)) {
      return;
    }
    try {
      const result = await uninstallManagedPlugin(params);
      if (!result.ok) {
        respondServiceError(
          respond,
          "plugins.uninstall",
          result.error ?? { kind: "unavailable", message: "plugin uninstall failed" },
        );
        return;
      }
      respond(true, result, undefined);
    } catch (error) {
      respondServiceException(respond, "plugins.uninstall", error);
    }
  },
  "plugins.enable": async ({ params, respond }) => {
    if (!assertValidParams(params, validatePluginsEnableParams, "plugins.enable", respond)) {
      return;
    }
    try {
      await respondPluginToggle(respond, "plugins.enable", params.id, true);
    } catch (error) {
      respondServiceException(respond, "plugins.enable", error);
    }
  },
  "plugins.disable": async ({ params, respond }) => {
    if (!assertValidParams(params, validatePluginsDisableParams, "plugins.disable", respond)) {
      return;
    }
    try {
      await respondPluginToggle(respond, "plugins.disable", params.id, false);
    } catch (error) {
      respondServiceException(respond, "plugins.disable", error);
    }
  },
};

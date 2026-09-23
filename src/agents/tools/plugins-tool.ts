import { asNonArrayRecord, isRecord } from "@openclaw/normalization-core/record-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { Type } from "typebox";
import { GatewayClientRequestError } from "../../../packages/gateway-client/src/request-error.js";
import { boundedJsonUtf8Bytes } from "../../infra/json-utf8-bytes.js";
import type { PluginRuntimeApplication } from "../../plugins/lifecycle.js";
import type { listManagedPlugins } from "../../plugins/management-service.js";
import { captureAgentPluginRuntimeRefresh } from "../plugin-runtime-refresh.js";
import { stringEnum } from "../schema/typebox.js";
import { jsonResult, readToolStringParam, ToolInputError, type AnyAgentTool } from "./common.js";
import { callAgentToolGatewayRequest } from "./in-process-gateway.js";

const PLUGINS_TOOL_RESULT_MAX_BYTES = 3_840;

function pluginsToolResult(payload: Record<string, unknown>, refreshUnavailable = false) {
  const continuation = refreshUnavailable
    ? "The backend change was applied. Start a new conversation to load changed tool definitions in this runtime; do not repeat the mutation."
    : undefined;
  const response = continuation ? { ...payload, next: continuation } : payload;
  const size = boundedJsonUtf8Bytes(response, PLUGINS_TOOL_RESULT_MAX_BYTES);
  if (
    size.complete &&
    Buffer.byteLength(JSON.stringify(response, null, 2), "utf8") <= PLUGINS_TOOL_RESULT_MAX_BYTES
  ) {
    return jsonResult(response);
  }
  const details = isRecord(payload.details) ? payload.details : undefined;
  const persistence = isRecord(details?.persistence) ? details.persistence : undefined;
  const restartRequired = payload.restartRequired ?? details?.restartRequired;
  const runtime = isRecord(payload.runtime) ? payload.runtime : details?.runtime;
  const rawWarnings =
    payload.warnings ?? details?.warnings ?? (isRecord(runtime) ? runtime.warnings : undefined);
  const warnings = Array.isArray(rawWarnings)
    ? rawWarnings.filter((warning): warning is string => typeof warning === "string")
    : [];
  const compactRuntime = (value: unknown) => {
    if (!isRecord(value) || typeof value.generation !== "number") {
      return undefined;
    }
    const phase = value.phase;
    return {
      generation: value.generation,
      committed: typeof value.committed === "boolean" ? value.committed : payload.ok !== false,
      phase:
        phase === "prepare" || phase === "drain" || phase === "activate" || phase === "dispose"
          ? phase
          : undefined,
    };
  };
  // A review token is useful only alongside the complete capability review.
  // Keep the publication outcome, but omit oversized details as a whole.
  return jsonResult({
    ok: payload.ok !== false,
    restartRequired: typeof restartRequired === "boolean" ? restartRequired : undefined,
    warnings: warnings.length
      ? warnings.slice(0, 2).map((warning) => truncateUtf16Safe(warning, 160))
      : undefined,
    omittedWarningCount: warnings.length > 2 ? warnings.length - 2 : undefined,
    runtime: compactRuntime(runtime),
    runtimeAttempt: compactRuntime(details?.runtimeAttempt),
    ...(persistence?.operation === "install" ? { persistence: { operation: "install" } } : {}),
    detailsOmitted: "response_budget_exceeded",
    next: [
      continuation,
      "Use the Control UI Plugins page for the complete result and any required capability review. Read cleanup warnings before retrying. Narrow inventory or search queries. Inspect a saved install before retrying activation; do not reinstall it or repeat a completed mutation.",
    ]
      .filter(Boolean)
      .join(" "),
  });
}

const PluginsToolSchema = Type.Object(
  {
    action: stringEnum([
      "list",
      "inspect",
      "search",
      "install",
      "enable",
      "disable",
      "uninstall",
      "reload",
    ]),
    pluginId: Type.Optional(Type.String()),
    query: Type.Optional(
      Type.String({ description: "Filter the plugin inventory or search published plugins." }),
    ),
    source: Type.Optional(stringEnum(["official", "clawhub"])),
    packageName: Type.Optional(Type.String()),
    version: Type.Optional(
      Type.String({ description: "ClawHub package version; omit for official catalog installs." }),
    ),
    reviewToken: Type.Optional(
      Type.String({ description: "Capability review acknowledged by the operator." }),
    ),
    acknowledgeInstallPolicyWarning: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export function createPluginsTool(): AnyAgentTool {
  const runtimeRefresh = captureAgentPluginRuntimeRefresh();
  return {
    name: "plugins",
    label: "Plugins",
    description:
      "Inspect, search, install from the official catalog or ClawHub, enable, disable, uninstall, or reload plugins without restarting the Gateway. Reload an installed plugin after editing its local files. Cleanup is best effort; read warnings in the result. Supported conversations refresh their tools at the next model step after running programs settle; finish the current program before using changed tools. Other runtimes may require a new conversation for changed tool names or schemas. Do not repeat completed mutations.",
    parameters: PluginsToolSchema,
    execute: async (_toolCallId, args, signal) => {
      runtimeRefresh.assertCurrent();
      const params = asNonArrayRecord(args);
      const action = readToolStringParam(params, "action", { required: true });
      const required = (key: string) => readToolStringParam(params, key, { required: true });
      const reviewToken = readToolStringParam(params, "reviewToken");
      const consent = reviewToken ? { acknowledgeCapabilities: { reviewToken } } : {};
      let method: string;
      let request: Record<string, unknown>;
      switch (action) {
        case "list":
          method = "plugins.list";
          request = {};
          break;
        case "inspect":
        case "uninstall":
        case "reload":
          method = `plugins.${action}`;
          request =
            action === "reload"
              ? { plugins: [{ pluginId: required("pluginId") }], ...consent }
              : { pluginId: required("pluginId") };
          break;
        case "search":
          method = "plugins.search";
          request = { query: required("query"), limit: 10 };
          break;
        case "enable":
        case "disable":
          method = "plugins.setEnabled";
          request = { pluginId: required("pluginId"), enabled: action === "enable", ...consent };
          break;
        case "install": {
          const source = required("source");
          if (!["official", "clawhub"].includes(source)) {
            throw new ToolInputError(`Unknown plugin installation source: ${source}`);
          }
          if (source === "official" && params.version !== undefined) {
            throw new ToolInputError(
              "Official catalog installs do not accept a version. Use the CLI for a version-constrained install, or omit version to use the catalog selection.",
            );
          }
          const version = readToolStringParam(params, "version");
          method = "plugins.install";
          request = {
            source,
            ...(source === "official"
              ? { pluginId: required("pluginId") }
              : { packageName: required("packageName"), ...(version ? { version } : {}) }),
            ...(params.acknowledgeInstallPolicyWarning === true
              ? { acknowledgeInstallPolicyWarning: true }
              : {}),
            ...consent,
          };
          break;
        }
        default:
          throw new ToolInputError(`Unknown plugin action: ${action}`);
      }
      let result: Record<string, unknown> & { runtime?: PluginRuntimeApplication };
      try {
        result = await callAgentToolGatewayRequest({
          method,
          params: request,
          signal,
          timeoutMs: null,
        });
      } catch (error) {
        if (!(error instanceof GatewayClientRequestError)) {
          throw error;
        }
        const runtime =
          isRecord(error.details) && isRecord(error.details.runtime)
            ? error.details.runtime
            : undefined;
        const committed =
          runtime?.committed === true &&
          typeof runtime.operationId === "string" &&
          typeof runtime.generation === "number" &&
          Array.isArray(runtime.pluginIds) &&
          runtime.pluginIds.every((id) => typeof id === "string");
        const refresh = committed && runtimeRefresh.request();
        return {
          ...pluginsToolResult(
            { ok: false, code: error.gatewayCode, error: error.message, details: error.details },
            committed && !refresh,
          ),
          isError: true,
          ...(refresh ? { terminate: true } : {}),
        };
      }
      if (action === "list") {
        // SAFETY: The list action dispatches only plugins.list, whose handler returns listManagedPlugins.
        const inventory = result as Awaited<ReturnType<typeof listManagedPlugins>>;
        const query = readToolStringParam(params, "query")?.toLowerCase();
        const matching = inventory.plugins.filter(
          (plugin) =>
            !query ||
            [plugin.id, plugin.name, plugin.description].some((value) =>
              value?.toLowerCase().includes(query),
            ),
        );
        return pluginsToolResult({
          plugins: matching.slice(0, 20).map(({ id, state, version }) => ({ id, state, version })),
          matching: matching.length,
          omitted: Math.max(0, matching.length - 20),
          mutationAllowed: inventory.mutationAllowed,
          next: "Use query to narrow this inventory or inspect a pluginId for details.",
        });
      }
      const refresh = result.runtime && runtimeRefresh.request();
      return {
        ...pluginsToolResult(result, Boolean(result.runtime && !refresh)),
        ...(refresh ? { terminate: true } : {}),
      };
    },
  };
}

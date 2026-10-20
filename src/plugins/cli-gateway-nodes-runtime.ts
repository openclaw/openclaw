import { randomUUID } from "node:crypto";
import { addTimerTimeoutGraceMs } from "@openclaw/normalization-core/number-coercion";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../../packages/gateway-protocol/src/client-info.js";
import { normalizeOperatorScopeList } from "../gateway/operator-scopes.js";
import { createLazyImportLoader } from "../shared/lazy-promise.js";
import { getPluginRuntimeGatewayRequestScope } from "./runtime/gateway-request-scope.js";
import type { PluginRuntime } from "./runtime/types.js";

// Help builds plugin CLI registrations but never calls runtime.nodes. Keep the
// live Gateway/TLS graph behind the first node RPC so one-shot help stays inert.
const gatewayCallModuleLoader = createLazyImportLoader(() => import("../gateway/call.js"));

export function createPluginCliGatewayNodesRuntime(): PluginRuntime["nodes"] {
  return {
    async list(params) {
      const { callGateway } = await gatewayCallModuleLoader.load();
      const payload = await callGateway({
        method: "node.list",
        params: {},
        clientName: GATEWAY_CLIENT_NAMES.CLI,
        mode: GATEWAY_CLIENT_MODES.CLI,
      });
      const nodes = Array.isArray(payload?.nodes) ? payload.nodes : [];
      const filteredNodes =
        params?.connected === true
          ? nodes.filter(
              (node) =>
                node !== null &&
                typeof node === "object" &&
                (node as { connected?: unknown }).connected === true,
            )
          : nodes;
      return {
        nodes: filteredNodes as Awaited<ReturnType<PluginRuntime["nodes"]["list"]>>["nodes"],
      };
    },
    async invoke(params) {
      const { callGateway } = await gatewayCallModuleLoader.load();
      const normalizedScopes = normalizeOperatorScopeList(params.scopes);
      const scope = normalizedScopes ? getPluginRuntimeGatewayRequestScope() : undefined;
      const scopes =
        scope?.pluginId &&
        (scope.pluginOrigin === "bundled" || scope.pluginTrustedOfficialInstall === true)
          ? normalizedScopes
          : undefined;
      return await callGateway({
        method: "node.invoke",
        params: {
          nodeId: params.nodeId,
          command: params.command,
          ...(params.params !== undefined && { params: params.params }),
          timeoutMs: params.timeoutMs,
          idempotencyKey: params.idempotencyKey || randomUUID(),
          ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
        },
        timeoutMs:
          typeof params.timeoutMs === "number" &&
          Number.isFinite(params.timeoutMs) &&
          params.timeoutMs > 0
            ? addTimerTimeoutGraceMs(params.timeoutMs)
            : undefined,
        clientName: GATEWAY_CLIENT_NAMES.CLI,
        mode: GATEWAY_CLIENT_MODES.CLI,
        ...(scopes ? { scopes } : {}),
        ...(params.signal ? { signal: params.signal } : {}),
      });
    },
    async openDuplex() {
      throw new Error("Node duplex is unavailable in the CLI; run this plugin inside the Gateway.");
    },
  };
}

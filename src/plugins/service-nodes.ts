import { randomUUID } from "node:crypto";
import { addTimerTimeoutGraceMs } from "@openclaw/normalization-core/number-coercion";
import type { PluginRuntimeCapabilityLease } from "./capability-lease.js";
import { getPluginInstance } from "./plugin-instance-scope.js";
import { getPluginRecordRegistry, isPluginRecordActive } from "./registry-lifecycle.js";
import { getPluginRegistryRuntime } from "./registry-runtime-binding.js";
import type { PluginRecord, PluginRegistry } from "./registry-types.js";
import {
  getCanonicalGatewayContextResolver,
  getGatewayContextLifetime,
  getGatewayContextResolver,
} from "./runtime/gateway-request-scope.js";
import type { OpenClawPluginServiceContext } from "./types.js";

/** Issue node access owned by one service, independent of incoming RPC scopes. */
export function createPluginServiceNodeInvoker(options: {
  registry: PluginRegistry;
  record: PluginRecord;
  lease: PluginRuntimeCapabilityLease;
  isStopping: () => boolean;
}):
  | { invoke: NonNullable<OpenClawPluginServiceContext["invokeNode"]>; stop: () => void }
  | undefined {
  const { registry, record, lease } = options;
  const runtime = getPluginRegistryRuntime(registry);
  const resolver = runtime && getGatewayContextResolver(runtime.subagent);
  const gatewayOwner = resolver && getCanonicalGatewayContextResolver(resolver);
  if (!resolver || !gatewayOwner) {
    return undefined;
  }
  const lifetime = new AbortController();
  const instance = getPluginInstance(record);
  const signals = [lifetime.signal, getGatewayContextLifetime(gatewayOwner).signal];
  if (instance) {
    signals.push(instance.lifecycle.signal);
  }
  const stop = lease.retain(() => lifetime.abort(new Error("Plugin service node access stopped")));
  return {
    stop,
    async invoke(request) {
      const signal = AbortSignal.any(request.signal ? [...signals, request.signal] : signals);
      const assertCurrent = () => {
        signal.throwIfAborted();
        lease.assertActive("node access");
        if (options.isStopping() || !isPluginRecordActive(registry, record)) {
          throw new Error("Plugin service node access is no longer active");
        }
        const owner = getPluginRecordRegistry(registry, record);
        if (
          !owner.nodeHostCommands.some(
            (entry) => entry.pluginId === record.id && entry.command.command === request.command,
          )
        ) {
          throw new Error(`Plugin service cannot invoke unowned node command: ${request.command}`);
        }
      };
      assertCurrent();
      // Service creation must not eagerly load the Gateway dispatch graph.
      const [{ dispatchGatewayRequestInProcess }, { createSyntheticPluginRuntimeClient }] =
        await Promise.all([
          import("../gateway/server-in-process-dispatch.js"),
          import("../gateway/server-plugin-runtime-client.js"),
        ]);
      assertCurrent();
      const context = resolver();
      if (!context) {
        throw new Error("Plugin service Gateway is unavailable");
      }
      // The ordinary node.invoke handler still enforces pairing, command grants,
      // and plugin path policy. No caller-selected identity or scopes are accepted.
      const result = await dispatchGatewayRequestInProcess(
        "node.invoke",
        {
          nodeId: request.nodeId,
          command: request.command,
          params: request.params,
          timeoutMs: request.timeoutMs,
          idempotencyKey: request.idempotencyKey || randomUUID(),
          ...(request.sessionKey ? { sessionKey: request.sessionKey } : {}),
        },
        {
          client: createSyntheticPluginRuntimeClient({
            operatorRoleActor: { kind: "system" },
            pluginRuntimeOwnerId: record.id,
            nodeInvokeApprovalSessionKey: request.sessionKey,
            scopes: ["operator.write"],
          }),
          context,
          methodRegistry: context.getGatewayMethodRegistry?.(),
          requestIdPrefix: "plugin-service-node",
          signal,
          timeoutMs:
            request.timeoutMs !== undefined &&
            Number.isFinite(request.timeoutMs) &&
            request.timeoutMs > 0
              ? addTimerTimeoutGraceMs(request.timeoutMs)
              : undefined,
        },
      );
      assertCurrent();
      return result;
    },
  };
}

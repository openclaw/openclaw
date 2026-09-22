import { randomUUID } from "node:crypto";
import { addTimerTimeoutGraceMs } from "@openclaw/normalization-core/number-coercion";
import type { GatewayNodeInvokeStream } from "../gateway/server-methods/shared-types.js";
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
  | {
      invoke: NonNullable<OpenClawPluginServiceContext["invokeNode"]>;
      openDuplex: NonNullable<OpenClawPluginServiceContext["openNodeDuplex"]>;
      stop: () => void;
    }
  | undefined {
  const { registry, record, lease } = options;
  const runtime = getPluginRegistryRuntime(registry);
  // Host metadata must not initialize the lazy subagent runtime during service startup.
  const resolver = runtime && getGatewayContextResolver(runtime);
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
  type Request = Parameters<NonNullable<OpenClawPluginServiceContext["invokeNode"]>>[0];
  const prepare = (request: Request, duplex = false) => {
    const signal = AbortSignal.any(request.signal ? [...signals, request.signal] : signals);
    const assertCurrent = () => {
      signal.throwIfAborted();
      lease.assertActive("node access");
      if (options.isStopping() || !isPluginRecordActive(registry, record)) {
        throw new Error("Plugin service node access is no longer active");
      }
      const commands = getPluginRecordRegistry(registry, record).nodeHostCommands.filter(
        (entry) => entry.command.command === request.command,
      );
      if (commands.length !== 1 || commands[0]?.pluginId !== record.id) {
        throw new Error(`Plugin service cannot invoke unowned node command: ${request.command}`);
      }
      if (
        duplex &&
        commands[0].command.duplex !== true &&
        commands[0].command.duplex !== "optional"
      ) {
        throw new Error(
          `Plugin service node command must declare duplex: true or "optional": ${request.command}`,
        );
      }
    };
    assertCurrent();
    return { signal, assertCurrent };
  };
  const invoke = async (
    request: Request,
    authority: ReturnType<typeof prepare>,
    stream?: GatewayNodeInvokeStream,
    streamSignal?: AbortSignal,
  ) => {
    const { assertCurrent } = authority;
    const signal = streamSignal ?? authority.signal;
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
    const client = createSyntheticPluginRuntimeClient({
      operatorRoleActor: { kind: "system" },
      pluginRuntimeOwnerId: record.id,
      nodeInvokeApprovalSessionKey: request.sessionKey,
      scopes: ["operator.write"],
    });
    if (stream) {
      client.internal = { ...client.internal, nodeInvokeStream: stream };
    }
    // Ordinary node.invoke still enforces pairing, command grants and path policy.
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
        client,
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
  };
  return {
    stop,
    async invoke(request) {
      return await invoke(request, prepare(request));
    },
    async openDuplex(request) {
      const authority = prepare(request, true);
      const { openOwnedGatewayNodeDuplex } =
        await import("../gateway/server-plugins-node-runtime.js");
      authority.assertCurrent();
      const context = resolver();
      if (!context?.nodeRegistry) {
        throw new Error("Plugin service Gateway node registry is unavailable");
      }
      const boundAuthority = {
        signal: authority.signal,
        assertCurrent() {
          authority.assertCurrent();
          request.assertCurrent?.();
          if (resolver() !== context) {
            throw new Error("Plugin service Gateway changed during node invocation");
          }
        },
      };
      return await openOwnedGatewayNodeDuplex({
        params: request,
        context,
        ...boundAuthority,
        invokeNode: (params, stream, signal) => invoke(params, boundAuthority, stream, signal),
      });
    },
  };
}

import { getGatewayControlUiIngressHost } from "../gateway/remote-control-ui-ingress-host.js";
import type { PluginRuntimeCapabilityLease } from "./capability-lease.js";
import {
  GatewayControlUiIngressError,
  type GatewayControlUiIngressFactoryV1,
  type GatewayControlUiIngressV1,
} from "./gateway-ingress.types.js";
import { getPluginInstance } from "./plugin-instance-scope.js";
import { isPluginRecordActive } from "./registry-lifecycle.js";
import { getPluginRegistryRuntime } from "./registry-runtime-binding.js";
import type { PluginRecord, PluginRegistry } from "./registry-types.js";
import {
  getCanonicalGatewayContextResolver,
  getGatewayContextLifetime,
  getGatewayContextResolver,
} from "./runtime/gateway-request-scope.js";

/** Bind remote ingress to the admitted service, never the calling tool's authority. */
export function createPluginServiceControlUiIngress(options: {
  registry: PluginRegistry;
  record: PluginRecord;
  lease: PluginRuntimeCapabilityLease;
  isStopping: () => boolean;
}): { factory: GatewayControlUiIngressFactoryV1; stop: () => Promise<void> } | undefined {
  const { registry, record, lease } = options;
  if (record.origin !== "bundled" && record.trustedOfficialInstall !== true) {
    return undefined;
  }
  const runtime = getPluginRegistryRuntime(registry);
  const resolver = runtime && getGatewayContextResolver(runtime);
  const gatewayOwner = resolver && getCanonicalGatewayContextResolver(resolver);
  const host = gatewayOwner && getGatewayControlUiIngressHost(gatewayOwner);
  if (!resolver || !gatewayOwner || !host) {
    return undefined;
  }
  const lifetime = new AbortController();
  const instance = getPluginInstance(record);
  const signal = AbortSignal.any([
    lifetime.signal,
    host.signal,
    getGatewayContextLifetime(gatewayOwner).signal,
    ...(instance ? [instance.lifecycle.signal] : []),
  ]);
  const handles = new Set<GatewayControlUiIngressV1>();
  const opening = new Set<Promise<GatewayControlUiIngressV1>>();
  let stopping: Promise<void> | undefined;
  const assertCurrent = () => {
    signal.throwIfAborted();
    lease.assertActive("Control UI ingress");
    if (
      options.isStopping() ||
      !isPluginRecordActive(registry, record) ||
      getGatewayControlUiIngressHost(gatewayOwner) !== host ||
      !resolver()
    ) {
      throw new GatewayControlUiIngressError(
        "closed",
        "Plugin Control UI ingress is no longer active",
      );
    }
  };
  const stop = () => {
    if (!stopping) {
      lifetime.abort(
        new GatewayControlUiIngressError("closed", "Plugin Control UI ingress stopped"),
      );
      stopping = (async () => {
        await Promise.allSettled(opening);
        await Promise.all([...handles].map((handle) => handle.close()));
        handles.clear();
      })();
      void stopping.catch(() => {});
    }
    return stopping;
  };
  lease.retain(() => void stop());
  return {
    stop,
    factory: {
      open(input) {
        const operation = (async () => {
          assertCurrent();
          const { createGatewayControlUiIngressFactory } =
            await import("../gateway/remote-control-ui-ingress.js");
          assertCurrent();
          const handle = await createGatewayControlUiIngressFactory({
            pluginId: record.id,
            signal,
            assertCurrent,
            host,
          }).open(input);
          try {
            assertCurrent();
          } catch (error) {
            await handle.close();
            throw error;
          }
          const ownedHandle: GatewayControlUiIngressV1 = {
            presentation: handle.presentation,
            request: (request) => handle.request(request),
            openWebSocket: (request) => handle.openWebSocket(request),
            async close() {
              await handle.close();
              handles.delete(ownedHandle);
            },
          };
          handles.add(ownedHandle);
          return ownedHandle;
        })();
        opening.add(operation);
        void operation.finally(() => opening.delete(operation)).catch(() => {});
        return operation;
      },
    },
  };
}

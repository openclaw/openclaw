import { getGatewayControlUiIngressHost } from "../gateway/remote-control-ui-ingress-host.js";
import { materializeErrorStack } from "../infra/error-graph-internal.js";
import type { PluginRuntimeCapabilityLease } from "./capability-lease.js";
import {
  GatewayControlUiIngressError,
  type GatewayControlUiIngressFactoryV2,
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
}): { factory: GatewayControlUiIngressFactoryV2; stop: () => Promise<void> } | undefined {
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
  const stop = async () => {
    lifetime.abort(new GatewayControlUiIngressError("closed", "Plugin Control UI ingress stopped"));
    materializeErrorStack(lifetime.signal.reason);
  };
  lease.retain(() => void stop());
  const hostFactory = async () => {
    const { createGatewayControlUiIngressFactory } =
      await import("../gateway/remote-control-ui-ingress.js");
    return createGatewayControlUiIngressFactory({
      pluginId: record.id,
      signal,
      assertCurrent,
      host,
    });
  };
  return {
    stop,
    factory: {
      capabilityVersion: 2,
      open: async (input) => (await hostFactory()).open(input),
      bindPrincipal: async (input) => (await hostFactory()).bindPrincipal(input),
    },
  };
}

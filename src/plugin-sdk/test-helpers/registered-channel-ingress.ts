import { createChannelAdmissionAudit } from "../../channels/message-access/admission-evidence.js";
import type { ChannelPlugin } from "../../channels/plugins/types.plugin.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { GatewayRequestContext } from "../../gateway/server-methods/types.js";
import { getPluginInstance } from "../../plugins/plugin-instance-scope.js";
import {
  markPluginRegistryActive,
  markPluginRegistryRetired,
} from "../../plugins/registry-lifecycle.js";
import { bindGatewayContextResolver } from "../../plugins/runtime/gateway-request-scope.js";
import type { PluginRuntime } from "../../plugins/runtime/types.js";
import { createPluginRecord } from "../../plugins/status.test-helpers.js";

/** Exercise native registration, activation, and retirement without a live Gateway. */
export async function withRegisteredChannelIngress<T>(
  params: {
    plugin: ChannelPlugin;
    config: OpenClawConfig;
    setRuntime: (runtime: PluginRuntime) => void;
  },
  run: (runtime: PluginRuntime, retire: () => void) => Promise<T>,
): Promise<T> {
  const audit = createChannelAdmissionAudit({ enabled: true });
  const gateway = {
    channelAdmissionAudit: audit,
    getRuntimeConfig: () => params.config,
  } as GatewayRequestContext;
  const [{ createPluginRegistry }, { createPluginRuntime }] = await Promise.all([
    import("../../plugins/registry.js"),
    import("../../plugins/runtime/index.js"),
  ]);
  const runtime = createPluginRuntime();
  bindGatewayContextResolver(runtime.subagent, () => gateway);
  const builder = createPluginRegistry({
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    runtime,
    activateGlobalSideEffects: false,
  });
  const record = createPluginRecord({ id: params.plugin.id, origin: "bundled" });
  const api = builder.createApi(record, { config: params.config, registrationMode: "full" });
  const instance = getPluginInstance(record);
  if (!instance) {
    throw new Error("Registered API must retain its plugin instance");
  }
  const retire = () => markPluginRegistryRetired(builder.registry);
  try {
    instance.run(() => {
      api.registerChannel({ plugin: params.plugin });
      // defineBundledChannelEntry injects runtime before registry activation.
      params.setRuntime(api.runtime);
    });
    builder.registry.plugins.push(record);
    markPluginRegistryActive(builder.registry);
    return await instance.run(() => run(api.runtime, retire));
  } finally {
    retire();
    audit.close();
    await instance.dispose();
  }
}

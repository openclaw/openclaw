import type { LegacyPluginSdkResourceHost } from "../plugins/legacy-sdk-resource-host.js";
import { pluginInstanceInvocation } from "../plugins/plugin-instance-invocation.js";
import type { GatewayCloseOptions } from "./server-public.js";

/** Shutdown owns core persistence independently of the plugin that requested it. */
export function createGatewayCloseEntrypoints(
  host: LegacyPluginSdkResourceHost,
  prepareClose: (options?: GatewayCloseOptions) => Promise<() => Promise<void>>,
  closeOnStartupFailure: (error?: unknown) => Promise<void>,
) {
  const run = <T>(operation: () => T): T =>
    pluginInstanceInvocation.exit(() => host.run(operation));
  return {
    prepareClose: async (options?: GatewayCloseOptions) => {
      const close = await run(() => prepareClose(options));
      return () => run(close);
    },
    closeOnStartupFailure: (error?: unknown) => run(() => closeOnStartupFailure(error)),
  };
}

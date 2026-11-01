import type { GatewayContextResolver } from "../gateway/server-methods/types.js";
import { createLazyRuntimeMethodBinder, createLazyRuntimeSurface } from "../shared/lazy-runtime.js";
import type { PluginRuntimeCapabilityLease } from "./capability-lease.js";
import type { OpenClawPluginServiceContext } from "./plugin-registration.types.js";
import { createPluginServiceCronGetter, type PluginServiceCronHost } from "./service-cron.js";

export function createPluginServiceAutomationCapabilities(params: {
  pluginId: string;
  lease: PluginRuntimeCapabilityLease;
  isStopping: () => boolean;
  resolveGatewayContext?: GatewayContextResolver;
  getCronService?: () => PluginServiceCronHost | null | undefined;
}) {
  const common = {
    pluginId: params.pluginId,
    lease: params.lease,
    isStopping: params.isStopping,
    resolveGatewayContext: params.resolveGatewayContext,
  };
  const getCron = params.getCronService
    ? createPluginServiceCronGetter({ ...common, getCron: params.getCronService })
    : undefined;
  let mcpEvents: OpenClawPluginServiceContext["mcpEvents"];
  if (params.getCronService && params.resolveGatewayContext) {
    const getCronHost = params.getCronService;
    // Demand loading happens inside the already-retained service start/call,
    // never before services.ts has published that startup attempt's cleanup owner.
    const load = createLazyRuntimeSurface(
      () => import("./service-mcp-events.js"),
      (module) => module.createPluginServiceMcpEvents({ ...common, getCron: getCronHost }),
    );
    const bind = createLazyRuntimeMethodBinder(load);
    mcpEvents = {
      prepareSource: bind((service) => service.prepareSource),
    };
  }
  return { getCron, mcpEvents };
}

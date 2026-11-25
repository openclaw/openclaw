import type { GatewayContextResolver } from "../gateway/server-methods/types.js";
import { createLazyRuntimeMethodBinder, createLazyRuntimeSurface } from "../shared/lazy-runtime.js";
import type { PluginRuntimeCapabilityLease } from "./capability-lease.js";
import type { OpenClawPluginServiceContext } from "./plugin-registration.types.js";
import type { PluginRegistry } from "./registry-types.js";
import { createPluginServiceCronGetter, type PluginServiceCronHost } from "./service-cron.js";
import type { PluginServiceSessionWorkV1 } from "./service-session-work.types.js";

export function createPluginServiceAutomationCapabilities(params: {
  pluginId: string;
  serviceId: string;
  registry: PluginRegistry;
  signal: AbortSignal;
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
  const loadSessionWork = createLazyRuntimeSurface(
    () => import("./service-session-work.js"),
    (module) => module.createPluginServiceSessionWork(params),
  );
  const sessionWork: PluginServiceSessionWorkV1 = {
    version: 1,
    withCurrent: async ({ agentId, sessionKey, toolName }, work) =>
      (await loadSessionWork()).withCurrent({ agentId, sessionKey, toolName }, work),
    admit: async ({ id, agentId, sessionKey, toolName, delegatedTools }) => {
      // Capture admission before lazy loading yields to the original caller.
      const input = {
        id,
        agentId,
        sessionKey,
        toolName,
        ...(delegatedTools ? { delegatedTools: [...delegatedTools] } : {}),
      };
      return (await loadSessionWork()).admit(input);
    },
    run: async (id, work) => (await loadSessionWork()).run(id, work),
  };
  return { getCron, mcpEvents, sessionWork };
}

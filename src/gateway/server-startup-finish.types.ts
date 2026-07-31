import type { createSubsystemLogger } from "../logging/subsystem.js";
import type { startGatewayCoreRuntime } from "./server-core-runtime.js";

type GatewayCoreRuntime = Awaited<ReturnType<typeof startGatewayCoreRuntime>>;
type GatewayLogger = ReturnType<typeof createSubsystemLogger>;

export type FinishGatewayStartupParams = {
  coreRuntime: GatewayCoreRuntime;
  port: number;
  opts: GatewayCoreRuntime["opts"];
  log: GatewayLogger;
  logHealth: GatewayLogger;
  logWsControl: GatewayLogger;
  logHooks: GatewayLogger;
  logChannels: GatewayLogger;
  logCron: GatewayLogger;
  logReload: GatewayLogger;
  logTailscale: GatewayLogger;
  loadGatewayStartupPostAttachModule: () => Promise<
    typeof import("./server-startup-post-attach.js")
  >;
};

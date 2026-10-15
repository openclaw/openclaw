import type { createSubsystemLogger } from "../logging/subsystem.js";
import type { GatewayKernelRuntime } from "./server-kernel-request-runtime.js";
import type { GatewayHttpTransport } from "./server-transport-bridge.js";

type GatewayLogger = ReturnType<typeof createSubsystemLogger>;
type GatewayStartedRuntime = GatewayKernelRuntime & GatewayHttpTransport;

/** Parameters owned by startup completion. */
export type GatewayStartupFinishParams = {
  kernelRuntime: GatewayStartedRuntime;
  port: number;
  bootId: string;
  opts: GatewayStartedRuntime["opts"];
  log: GatewayLogger;
  logHealth: GatewayLogger;
  logWsControl: GatewayLogger;
  logHooks: GatewayLogger;
  logChannels: GatewayLogger;
  logCron: GatewayLogger;
  logReload: GatewayLogger;
  waitForPostReadyWork: () => Promise<void>;
};

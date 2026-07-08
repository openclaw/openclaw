// Gateway live state factory.
// Combines mutable runtime handles with startup-resolved services for request contexts.
import type { PluginServicesHandle } from "../plugins/services.js";
import type { HookQueueRuntime } from "./hook-queue-runtime.js";
import type { HooksConfigResolved } from "./hooks.js";
import type { GatewayCronState } from "./server-cron.js";
import {
  createGatewayServerMutableState,
  type GatewayServerMutableState,
} from "./server-runtime-handles.js";
import type { HookClientIpConfig } from "./server/hooks-request-handler.js";

/** Mutable gateway server state shared across request contexts. */
export type GatewayServerLiveState = GatewayServerMutableState & {
  hooksConfig: HooksConfigResolved | null;
  hookClientIpConfig: HookClientIpConfig;
  hookQueueRuntime: HookQueueRuntime;
  cronState: GatewayCronState;
  pluginServices: PluginServicesHandle | null;
  gatewayMethods: string[];
};

/** Creates gateway live state with fresh mutable runtime handles. */
export function createGatewayServerLiveState(params: {
  hooksConfig: HooksConfigResolved | null;
  hookClientIpConfig: HookClientIpConfig;
  hookQueueRuntime: HookQueueRuntime;
  cronState: GatewayCronState;
  gatewayMethods: string[];
}): GatewayServerLiveState {
  return {
    ...createGatewayServerMutableState(),
    hooksConfig: params.hooksConfig,
    hookClientIpConfig: params.hookClientIpConfig,
    hookQueueRuntime: params.hookQueueRuntime,
    cronState: params.cronState,
    pluginServices: null,
    gatewayMethods: params.gatewayMethods,
  };
}

import type { PluginServicesHandle } from "../plugins/services.js";
import type { GatewayControlUiConfig } from "../config/types.gateway.js";
import type { HooksConfigResolved } from "./hooks.js";
import type { GatewayCronState } from "./server-cron.js";
import type { HookClientIpConfig } from "./server-http.js";
import {
  createGatewayServerMutableState,
  type GatewayServerMutableState,
} from "./server-runtime-handles.js";

export type GatewayServerLiveState = GatewayServerMutableState & {
  hooksConfig: HooksConfigResolved | null;
  hookClientIpConfig: HookClientIpConfig;
  controlUiConfig: GatewayControlUiConfig | undefined;
  cronState: GatewayCronState;
  pluginServices: PluginServicesHandle | null;
  gatewayMethods: string[];
};

export function createGatewayServerLiveState(params: {
  hooksConfig: HooksConfigResolved | null;
  hookClientIpConfig: HookClientIpConfig;
  controlUiConfig: GatewayControlUiConfig | undefined;
  cronState: GatewayCronState;
  gatewayMethods: string[];
}): GatewayServerLiveState {
  return {
    ...createGatewayServerMutableState(),
    hooksConfig: params.hooksConfig,
    hookClientIpConfig: params.hookClientIpConfig,
    controlUiConfig: params.controlUiConfig,
    cronState: params.cronState,
    pluginServices: null,
    gatewayMethods: params.gatewayMethods,
  };
}

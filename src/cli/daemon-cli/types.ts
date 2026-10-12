import type { FindExtraGatewayServicesOptions } from "../../daemon/inspect.js";
import type { GatewayRpcOpts as SharedGatewayRpcOpts } from "../gateway-rpc.types.js";

export type GatewayRpcOpts = Omit<SharedGatewayRpcOpts, "expectFinal"> & {
  localPortOverride?: number;
};

export type DaemonStatusOptions = {
  rpc: GatewayRpcOpts;
  probe: boolean;
  requireRpc: boolean;
  json: boolean;
} & FindExtraGatewayServicesOptions;

export type DaemonInstallOptions = {
  port?: string | number;
  runtime?: string;
  runtimePath?: string;
  expectedRuntimePin?: string;
  restoreServiceCli?: string;
  token?: string;
  wrapper?: string;
  allowUnconfigured?: boolean;
  force?: boolean;
  json?: boolean;
};

export type DaemonLifecycleOptions = {
  json?: boolean;
  force?: boolean;
  safe?: boolean;
  skipDeferral?: boolean;
  preserveDefinition?: boolean;
  wait?: string;
  disable?: boolean;
};

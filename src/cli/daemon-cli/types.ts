import type { FindExtraGatewayServicesOptions } from "../../daemon/inspect.js";

export type GatewayRpcOpts = {
  url?: string;
  token?: string;
  password?: string;
  timeout?: string;
  json?: boolean;
};

export type DaemonServiceScope = "agent" | "daemon" | "auto";

export type DaemonStatusOptions = {
  rpc: GatewayRpcOpts;
  probe: boolean;
  json: boolean;
  scope?: DaemonServiceScope;
} & FindExtraGatewayServicesOptions;

export type DaemonInstallOptions = {
  port?: string | number;
  runtime?: string;
  token?: string;
  force?: boolean;
  json?: boolean;
  scope?: Exclude<DaemonServiceScope, "auto">;
};

export type DaemonLifecycleOptions = {
  json?: boolean;
  scope?: DaemonServiceScope;
};

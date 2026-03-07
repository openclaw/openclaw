import type { FindExtraGatewayServicesOptions } from "../../daemon/inspect.js";

export type GatewayRpcOpts = {
  url?: string;
  token?: string;
  password?: string;
  timeout?: string;
  json?: boolean;
};

export type DaemonStatusOptions = {
  rpc: GatewayRpcOpts;
  probe: boolean;
  json: boolean;
} & FindExtraGatewayServicesOptions;

export type DaemonInstallOptions = {
  port?: string | number;
  runtime?: string;
  token?: string;
  force?: boolean;
  json?: boolean;
};

export type DaemonLifecycleOptions = {
  json?: boolean;
  /** If set, write a restart sentinel targeting the main session before restarting. */
  notify?: boolean;
  /** Optional note to include in the post-restart message (only used with notify). */
  note?: string;
};

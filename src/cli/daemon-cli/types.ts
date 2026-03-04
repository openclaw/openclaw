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
  /** macOS only: install as LaunchDaemon (starts at boot without login; requires sudo). */
  launchDaemon?: boolean;
  /** macOS LaunchDaemon: user to run as (default: current user). */
  runAsUser?: string;
};

export type DaemonLifecycleOptions = {
  json?: boolean;
};

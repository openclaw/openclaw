import type { OperatorScope } from "../gateway/method-scopes.js";
import { captureLocalOperatorTokenRemoval } from "./devices-cli.credentials.js";
import { callGatewayFromCliWithTransport } from "./gateway-rpc.js";

export type DevicesRpcOpts = {
  url?: string;
  token?: string;
  password?: string;
  timeout?: string;
  json?: boolean;
  latest?: boolean;
  yes?: boolean;
  pending?: boolean;
  device?: string;
  role?: string;
  scope?: string[];
  scopes?: boolean;
  name?: string;
};

const DEFAULT_DEVICES_TIMEOUT_MS = 10_000;

export const callDevicesGateway = async (
  method: string,
  opts: DevicesRpcOpts,
  params?: unknown,
  callOpts?: { scopes?: OperatorScope[]; removedLocalDeviceId?: string },
) => {
  const forgetLocalToken = callOpts?.removedLocalDeviceId
    ? await captureLocalOperatorTokenRemoval(opts, callOpts.removedLocalDeviceId)
    : undefined;
  const result = await callGatewayFromCliWithTransport(method, opts, params, {
    label: `Devices ${method}`,
    defaultTimeoutMs: DEFAULT_DEVICES_TIMEOUT_MS,
    scopes: callOpts?.scopes,
    sharedStateMode: "read-only",
  });
  await forgetLocalToken?.();
  return result;
};

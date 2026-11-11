import type { OperatorScope } from "../gateway/method-scopes.js";
import { callGatewayFromCliWithTransport } from "./gateway-rpc.js";

const DEFAULT_DEVICES_TIMEOUT_MS = 10_000;

export const callDevicesGateway = async (
  method: string,
  opts: Parameters<typeof callGatewayFromCliWithTransport>[1],
  params?: unknown,
  callOpts?: { scopes?: OperatorScope[]; signal?: AbortSignal },
) =>
  callGatewayFromCliWithTransport(method, opts, params, {
    label: `Devices ${method}`,
    defaultTimeoutMs: DEFAULT_DEVICES_TIMEOUT_MS,
    scopes: callOpts?.scopes,
    signal: callOpts?.signal,
    sharedStateMode: "read-only",
  });

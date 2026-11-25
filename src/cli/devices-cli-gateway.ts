import type { OperatorScope } from "../gateway/method-scopes.js";
import { getAsyncWorkSignal } from "../shared/async-work-scope.js";
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

/** Ctrl+C owns the exit; a read that settles after it must not be printed. */
export async function readUnlessAborted<T>(
  read: (signal?: AbortSignal) => Promise<T>,
): Promise<T | null> {
  const signal = getAsyncWorkSignal();
  try {
    const value = await read(signal);
    return signal?.aborted ? null : value;
  } catch (error) {
    if (!signal?.aborted) {
      throw error;
    }
  }
  return null;
}

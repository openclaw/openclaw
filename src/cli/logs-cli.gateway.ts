// Gateway logs.tail transport for the logs CLI: one-shot reads, or one admitted follow connection.
import type { GatewayRequestFunction } from "../gateway/call-options.js";
import { callGatewayFromCliWithTransport } from "./gateway-rpc.js";
import { parseTimeoutMsWithFallback } from "./parse-timeout.js";

type LogsTailCall = Parameters<typeof callGatewayFromCliWithTransport>;

/** The admitted Gateway connection that `logs --follow` polls until it drops. */
export type LogsFollowConnection = {
  request?: GatewayRequestFunction;
  close?: () => void;
  closed?: Promise<unknown>;
};

export async function requestLogsTail(
  opts: LogsTailCall[1],
  params: LogsTailCall[2],
  extra: NonNullable<LogsTailCall[3]>,
  follow?: LogsFollowConnection,
): Promise<unknown> {
  if (!follow) {
    return await callGatewayFromCliWithTransport("logs.tail", opts, params, extra);
  }
  // Each follow poll, including connecting for the first one, keeps the --timeout deadline.
  const timeoutMs = parseTimeoutMsWithFallback(opts.timeout ?? undefined, 30_000);
  const deadline = AbortSignal.timeout(timeoutMs);
  const signal = extra.signal ? AbortSignal.any([extra.signal, deadline]) : deadline;
  try {
    if (follow.request) {
      return await follow.request("logs.tail", params, { timeoutMs: null, signal });
    }
    const firstResult = Promise.withResolvers<unknown>();
    // The poll deadline may end the connection only until its first response arrives.
    const connectionAbort = new AbortController();
    signal.addEventListener("abort", () => follow.request ?? connectionAbort.abort(), {
      once: true,
    });
    const call = callGatewayFromCliWithTransport("logs.tail", opts, params, {
      ...extra,
      signal: extra.signal
        ? AbortSignal.any([extra.signal, connectionAbort.signal])
        : connectionAbort.signal,
      timeoutMs: null,
      onResponse: (request, connectionSignal, result) => {
        const connection = Promise.withResolvers<void>();
        const drop = () => {
          follow.request = undefined;
          connection.resolve();
        };
        follow.request = request;
        follow.close = drop;
        connectionSignal.addEventListener("abort", drop, { once: true });
        firstResult.resolve(result);
        return connection.promise;
      },
    });
    follow.closed = call.then(
      () => undefined,
      (error: unknown) => error,
    );
    return await Promise.race([firstResult.promise, call]);
  } catch (error) {
    // A failed poll retires the connection; the follow retry path reconnects. A dropped
    // connection reports its typed close, so auth and policy closes stay terminal.
    follow.close?.();
    const closeError = await follow.closed;
    throw deadline.aborted && !extra.signal?.aborted
      ? new Error(`gateway timeout after ${timeoutMs}ms`)
      : (closeError ?? error);
  }
}

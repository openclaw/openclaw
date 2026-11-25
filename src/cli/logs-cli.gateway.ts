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
  if (follow.request) {
    // A failed poll retires the connection; the follow retry path reconnects.
    return await follow
      .request("logs.tail", params, {
        timeoutMs: parseTimeoutMsWithFallback(opts.timeout ?? undefined, 30_000),
        signal: extra.signal,
      })
      .catch((error: unknown) => {
        follow.close?.();
        throw error;
      });
  }
  const firstResult = Promise.withResolvers<unknown>();
  // Keep the connection after its first response; only connecting has a deadline.
  const call = callGatewayFromCliWithTransport("logs.tail", opts, params, {
    ...extra,
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
  follow.closed = call.catch(() => undefined);
  return await Promise.race([firstResult.promise, call]);
}

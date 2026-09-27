import { GatewayClient, type GatewayClientOptions } from "../../src/gateway/client.js";

/** A failed stop cannot be treated as a retryable connection failure. */
export class GatewayTestClientCleanupError extends AggregateError {}

/** Own acquisition until hello-ok, without imposing identity or protocol defaults. */
export async function acquireGatewayTestClient(
  options: Omit<GatewayClientOptions, "onConnectError" | "onClose">,
  wait: {
    timeoutMs: number;
    timeoutMessage: string;
    closeMessage: string;
    unrefTimeout?: boolean;
    signal?: AbortSignal;
    verifyCleanup?: (cleanup: () => Promise<void>) => Promise<void>;
  },
): Promise<GatewayClient> {
  const signal = wait.signal;
  signal?.throwIfAborted();
  return await new Promise<GatewayClient>((resolve, reject) => {
    let state: "pending" | "failed" | "handed-off" = "pending";
    const onAbort = () => settle({ error: signal?.reason });
    const settle = (outcome: { client: GatewayClient } | { error: unknown }) => {
      if (state !== "pending") {
        return;
      }
      const result = "client" in outcome && signal?.aborted ? { error: signal.reason } : outcome;
      state = "error" in result ? "failed" : "handed-off";
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if ("error" in result) {
        // Join the client's bounded stop contract before rejecting acquisition.
        // Its 250ms terminate fallback is not a guarantee of a raw WS close event.
        void (async () => {
          try {
            const cleanup = () => client.stopAndWait({ timeoutMs: 1_000 });
            await (wait.verifyCleanup ? wait.verifyCleanup(cleanup) : cleanup());
          } catch (cleanupError) {
            throw new GatewayTestClientCleanupError(
              [result.error, cleanupError],
              "QA gateway fixture failed",
            );
          }
          throw result.error;
        })().catch(reject);
      } else {
        resolve(result.client);
      }
    };
    const client = new GatewayClient({
      ...options,
      onHelloOk: (hello) => {
        if (state === "failed") {
          return;
        }
        if (state === "pending" && signal?.aborted) {
          settle({ error: signal.reason });
          return;
        }
        options.onHelloOk?.(hello);
        settle({ client });
      },
      onConnectError: (error) => settle({ error }),
      onClose: (code, reason) =>
        settle({ error: new Error(`${wait.closeMessage} (${code}): ${reason}`) }),
    });
    const timer = setTimeout(
      () => settle({ error: new Error(wait.timeoutMessage) }),
      wait.timeoutMs,
    );
    if (wait.unrefTimeout) {
      timer.unref();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      signal?.throwIfAborted();
      client.start();
    } catch (error) {
      settle({ error });
    }
  });
}

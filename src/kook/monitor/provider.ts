// KOOK WebSocket Provider
// Handles Gateway connection, signals, and heartbeat

import { WebSocket } from "ws";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { RuntimeEnv } from "../../runtime.js";
import { danger, warn } from "../../globals.js";
import { getKookGateway } from "../api.js";
import { createKookMessageHandler } from "./message-handler.js";

// Promisify abort signal
function promisifyAbortSignal(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    signal.addEventListener("abort", () => {
      reject(new DOMException("Aborted", "AbortError"));
    });
  });
}

export type MonitorKookOpts = {
  token: string;
  accountId: string;
  config: OpenClawConfig;
  runtime: RuntimeEnv;
  abortSignal?: AbortSignal;
  historyLimit?: number;
  mediaMaxMb?: number;
};

type KookSignal =
  | { s: 0; d: KookEventData; sn: number } // EVENT
  | { s: 1; d: { code: number; session_id?: string } } // HELLO
  | { s: 3 } // PONG
  | { s: 5; d: { code: number; err?: string } } // RECONNECT
  | { s: 6; d: { session_id: string } }; // RESUME_ACK

type KookEventData = {
  channel_type: string;
  type: number;
  target_id: string;
  author_id: string;
  content: string;
  msg_id: string;
  msg_timestamp: number;
  nonce: string;
  extra: Record<string, unknown>;
};

/**
 * Monitor KOOK gateway and handle events
 */
export async function monitorKookProvider(opts: MonitorKookOpts): Promise<void> {
  const runtime = opts.runtime;

  // Create message handler
  const messageHandler = createKookMessageHandler({
    cfg: opts.config,
    accountId: opts.accountId,
    token: opts.token,
    runtime: opts.runtime,
    historyLimit: opts.historyLimit,
    mediaMaxMb: opts.mediaMaxMb,
  });

  const sleepWithAbort = (ms: number, signal?: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new DOMException("Aborted", "AbortError"));
        return;
      }
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        reject(new DOMException("Aborted", "AbortError"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    });

  let reconnectAttempt = 0;
  while (!opts.abortSignal?.aborted) {
    let ws: WebSocket | null = null;
    let currentSn = 0;
    let heartbeatTimer: NodeJS.Timeout | null = null;
    let heartbeatTimeout: NodeJS.Timeout | null = null;
    let settleClosed: (() => void) | null = null;
    const closed = new Promise<void>((resolve) => {
      settleClosed = resolve;
    });
    const markClosed = () => {
      settleClosed?.();
      settleClosed = null;
    };
    const clearHeartbeatTimers = () => {
      if (heartbeatTimer) {
        clearTimeout(heartbeatTimer);
        heartbeatTimer = null;
      }
      if (heartbeatTimeout) {
        clearTimeout(heartbeatTimeout);
        heartbeatTimeout = null;
      }
    };
    const cleanup = () => {
      clearHeartbeatTimers();
      if (ws) {
        ws.removeAllListeners();
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
          ws.close();
        }
      }
      ws = null;
      markClosed();
    };

    try {
      // Get gateway URL (disable compression for simpler handling)
      const gatewayUrl = await getKookGateway(opts.token, false, opts.abortSignal);

      // Connect WebSocket
      ws = new WebSocket(gatewayUrl);

      // Wait for connection
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error("Connection timeout"));
        }, 10000);
        ws!.once("open", () => {
          clearTimeout(timeout);
          resolve();
        });
        ws!.once("error", (err) => {
          clearTimeout(timeout);
          reject(err);
        });
      });

      // Heartbeat function
      const startHeartbeat = () => {
        const scheduleNextHeartbeat = () => {
          if (!ws || ws.readyState !== WebSocket.OPEN) {
            return;
          }
          const intervalMs = 30000 + Math.random() * 10000 - 5000; // 30s +/- 5s
          heartbeatTimer = setTimeout(() => {
            if (!ws || ws.readyState !== WebSocket.OPEN) {
              return;
            }

            // Send PING with current sn
            ws.send(JSON.stringify({ s: 2, sn: currentSn }));

            // Set 6s timeout for PONG
            if (heartbeatTimeout) {
              clearTimeout(heartbeatTimeout);
            }
            heartbeatTimeout = setTimeout(() => {
              runtime.error?.(danger("[kook] heartbeat timeout"));
              cleanup();
            }, 6000);
            scheduleNextHeartbeat();
          }, intervalMs);
        };

        if (heartbeatTimer) {
          clearTimeout(heartbeatTimer);
          heartbeatTimer = null;
        }
        scheduleNextHeartbeat();
      };

      // Handle messages
      ws.on("message", async (data: Buffer) => {
        try {
          // Gateway was requested with compress=0, so data should be plain text
          // Try to parse as UTF-8 string directly
          let dataStr: string;
          try {
            dataStr = data.toString("utf8");
          } catch {
            return;
          }

          if (!dataStr.trim()) {
            return; // Skip empty messages
          }

          let signal: KookSignal;
          try {
            signal = JSON.parse(dataStr) as KookSignal;
          } catch {
            return;
          }

          switch (signal.s) {
            case 1: {
              // HELLO
              if (signal.d.code !== 0) {
                const errorMsg =
                  signal.d.code === 40101
                    ? "Invalid token"
                    : signal.d.code === 40102
                      ? "Token verification failed"
                      : signal.d.code === 40103
                        ? "Token expired"
                        : `Unknown error: ${signal.d.code}`;
                runtime.error?.(danger(`[kook] HELLO failed: ${errorMsg}`));
                cleanup();
                return;
              }

              // Start heartbeat
              startHeartbeat();
              break;
            }

            case 0: {
              // EVENT - Message event with sn
              if (signal.sn !== undefined) {
                // Guard against out-of-order or duplicate events.
                if (signal.sn <= currentSn) {
                  warn(
                    `[kook] drop stale event sn=${signal.sn}, currentSn=${currentSn}, type=${signal.d.type}`,
                  );
                  break;
                }
                currentSn = signal.sn;
                await messageHandler(signal.d);
              } else {
                // Some events may not have sn, process immediately
                await messageHandler(signal.d);
              }
              break;
            }

            case 3: {
              // PONG
              if (heartbeatTimeout) {
                clearTimeout(heartbeatTimeout);
                heartbeatTimeout = null;
              }
              break;
            }

            case 5: {
              // RECONNECT
              warn(`[kook] RECONNECT received: code=${signal.d.code}, err=${signal.d.err}`);
              currentSn = 0;
              cleanup();
              break;
            }

            case 6: {
              // RESUME_ACK
              break;
            }
          }
        } catch (error) {
          runtime.error?.(`[kook] message handler error: ${String(error)}`);
        }
      });

      // Handle errors
      ws.on("error", (error) => {
        runtime.error?.(danger(`[kook] WebSocket error: ${error}`));
      });

      // Handle close
      ws.on("close", (code, reason) => {
        warn(`[kook] WebSocket closed: code=${code}, reason=${reason.toString()}`);
        clearHeartbeatTimers();
        markClosed();
      });

      reconnectAttempt = 0;
      if (opts.abortSignal) {
        await Promise.race([closed, promisifyAbortSignal(opts.abortSignal)]);
      } else {
        await closed;
      }
    } catch (error) {
      if (!opts.abortSignal?.aborted) {
        runtime.error?.(danger(`[kook] provider loop error: ${String(error)}`));
      }
    } finally {
      cleanup();
    }

    if (opts.abortSignal?.aborted) {
      break;
    }
    reconnectAttempt += 1;
    const delayMs = Math.min(30000, 1000 * 2 ** Math.min(reconnectAttempt - 1, 5));
    warn(`[kook] reconnecting in ${delayMs}ms (attempt ${reconnectAttempt})`);
    try {
      await sleepWithAbort(delayMs, opts.abortSignal);
    } catch {
      break;
    }
  }
}

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
  let ws: WebSocket | null = null;
  let sessionId: string | null = null;
  let currentSn = 0;
  let heartbeatInterval: NodeJS.Timeout | null = null;
  let heartbeatTimeout: NodeJS.Timeout | null = null;

  // Create message handler
  const messageHandler = createKookMessageHandler({
    cfg: opts.config,
    accountId: opts.accountId,
    token: opts.token,
    runtime: opts.runtime,
    historyLimit: opts.historyLimit,
    mediaMaxMb: opts.mediaMaxMb,
  });

  // Clean up function
  const cleanup = () => {
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
    }
    if (heartbeatTimeout) {
      clearTimeout(heartbeatTimeout);
    }
    if (ws) {
      ws.removeAllListeners();
      ws.close();
    }
  };

  // Handle abort signal
  if (opts.abortSignal) {
    opts.abortSignal.addEventListener("abort", cleanup);
  }

  try {
    // Get gateway URL (disable compression for simpler handling)
    const gatewayUrl = await getKookGateway(opts.token, false);

    // Connect WebSocket
    ws = new WebSocket(gatewayUrl);

    // Wait for connection
    await new Promise<void>((resolve, reject) => {
      ws!.once("open", () => {
        resolve();
      });
      ws!.once("error", (err) => {
        reject(err);
      });
      setTimeout(() => {
        reject(new Error("Connection timeout"));
      }, 10000);
    });

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

            sessionId = signal.d.session_id || null;

            // Start heartbeat
            startHeartbeat();
            break;
          }

          case 0: {
            // EVENT - Message event with sn
            if (signal.sn !== undefined) {
              // Update current sn for this event
              currentSn = signal.sn;

              // TODO: Implement message ordering with buffer for out-of-order messages
              // For now, process immediately
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
            // Clear session and reconnect
            sessionId = null;
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
      cleanup();
    });

    // Heartbeat function
    function startHeartbeat() {
      if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
      }

      heartbeatInterval = setInterval(
        () => {
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
        },
        30000 + Math.random() * 10000 - 5000, // 30s ± 5s
      );
    }

    // Wait for abort
    if (opts.abortSignal) {
      await promisifyAbortSignal(opts.abortSignal);
    } else {
      await new Promise(() => {}); // Wait forever
    }
  } finally {
    cleanup();
  }
}

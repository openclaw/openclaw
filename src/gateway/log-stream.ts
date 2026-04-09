import { WebSocket } from "ws";
import { getResolvedLoggerSettings } from "../logging.js";
import type { GatewayBroadcastToConnIdsFn } from "./server-broadcast.js";
import { readLogSlice, resolveLogFile } from "./log-tail.js";
import type { GatewayWsClient } from "./server/ws-types.js";

const LOG_POLL_INTERVAL_MS = 1_000;
export const MAX_LOG_STREAM_SUBSCRIBERS = 16;
export const MAX_LOG_STREAM_SUBSCRIBERS_PER_IP = 4;
export const MAX_LOG_STREAM_LIMIT = 500;
export const MAX_LOG_STREAM_BYTES = 250_000;

type LogSubscriber = {
  connId: string;
  clientIp?: string;
  active: boolean;
  file?: string;
  cursor?: number;
  limit: number;
  maxBytes: number;
  polling: boolean;
};

export type GatewayLogStream = {
  subscribe: (
    connId: string,
    opts?: {
      paused?: boolean;
      file?: string;
      cursor?: number;
      limit?: number;
      maxBytes?: number;
    },
  ) => boolean;
  activate: (connId: string) => void;
  unsubscribe: (connId: string) => void;
  close: () => void;
};

export function createGatewayLogStream(params: {
  getClientByConnId: (connId: string) => GatewayWsClient | undefined;
  broadcastToConnIds: GatewayBroadcastToConnIdsFn;
}): GatewayLogStream {
  const subscribers = new Map<string, LogSubscriber>();

  const unsubscribe = (connId: string) => {
    subscribers.delete(connId.trim());
  };

  const pollSubscriber = async (subscriber: LogSubscriber): Promise<void> => {
    if (subscriber.polling || !subscriber.active) {
      return;
    }
    subscriber.polling = true;
    try {
      const gatewayClient = params.getClientByConnId(subscriber.connId);
      if (!gatewayClient || gatewayClient.socket.readyState !== WebSocket.OPEN) {
        unsubscribe(subscriber.connId);
        return;
      }
      const configuredFile = getResolvedLoggerSettings().file;
      const file = await resolveLogFile(configuredFile);
      const result = await readLogSlice({
        file,
        previousFile: subscriber.file,
        cursor: subscriber.cursor,
        limit: subscriber.limit,
        maxBytes: subscriber.maxBytes,
      });
      if (
        subscribers.get(subscriber.connId) !== subscriber ||
        !subscriber.active ||
        params.getClientByConnId(subscriber.connId)?.socket.readyState !== WebSocket.OPEN
      ) {
        return;
      }
      subscriber.file = file;
      subscriber.cursor = result.cursor;
      if (!result.reset && result.lines.length === 0) {
        return;
      }
      params.broadcastToConnIds(
        "logs.appended",
        {
          file,
          ...result,
        },
        new Set([subscriber.connId]),
      );
    } catch {
      const gatewayClient = params.getClientByConnId(subscriber.connId);
      unsubscribe(subscriber.connId);
      try {
        if (gatewayClient?.socket.readyState === WebSocket.OPEN) {
          gatewayClient.socket.close(1011, "log stream error");
        }
      } catch {}
    } finally {
      subscriber.polling = false;
    }
  };

  const timer = setInterval(() => {
    for (const subscriber of subscribers.values()) {
      void pollSubscriber(subscriber);
    }
  }, LOG_POLL_INTERVAL_MS);
  timer.unref?.();

  return {
    subscribe: (connId, opts) => {
      const normalizedConnId = connId.trim();
      if (!normalizedConnId) {
        return false;
      }
      const gatewayClient = params.getClientByConnId(normalizedConnId);
      if (!gatewayClient) {
        return false;
      }
      const existingSubscriber = subscribers.get(normalizedConnId);
      if (!existingSubscriber) {
        if (subscribers.size >= MAX_LOG_STREAM_SUBSCRIBERS) {
          return false;
        }
        const clientIp = gatewayClient.clientIp?.trim();
        if (clientIp) {
          let subscriptionsForIp = 0;
          for (const subscriber of subscribers.values()) {
            if (subscriber.clientIp === clientIp) {
              subscriptionsForIp += 1;
            }
          }
          if (subscriptionsForIp >= MAX_LOG_STREAM_SUBSCRIBERS_PER_IP) {
            return false;
          }
        }
      }
      subscribers.set(normalizedConnId, {
        connId: normalizedConnId,
        clientIp: gatewayClient.clientIp?.trim() || undefined,
        active: opts?.paused !== true,
        file: typeof opts?.file === "string" ? opts.file : undefined,
        cursor: typeof opts?.cursor === "number" ? opts.cursor : undefined,
        limit:
          typeof opts?.limit === "number"
            ? Math.max(1, Math.min(MAX_LOG_STREAM_LIMIT, Math.floor(opts.limit)))
            : MAX_LOG_STREAM_LIMIT,
        maxBytes:
          typeof opts?.maxBytes === "number"
            ? Math.max(1, Math.min(MAX_LOG_STREAM_BYTES, Math.floor(opts.maxBytes)))
            : MAX_LOG_STREAM_BYTES,
        polling: false,
      });
      return true;
    },
    activate: (connId) => {
      const subscriber = subscribers.get(connId.trim());
      if (!subscriber) {
        return;
      }
      subscriber.active = true;
      void pollSubscriber(subscriber);
    },
    unsubscribe,
    close: () => {
      clearInterval(timer);
      subscribers.clear();
    },
  };
}

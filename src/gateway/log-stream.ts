import { WebSocket } from "ws";
import { getResolvedLoggerSettings } from "../logging.js";
import { readLogSlice, resolveLogFile } from "./log-tail.js";
import { MAX_BUFFERED_BYTES } from "./server-constants.js";
import type { GatewayWsClient } from "./server/ws-types.js";

const LOG_POLL_INTERVAL_MS = 1_000;

type LogSubscriber = {
  connId: string;
  socket: WebSocket;
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
      if (subscriber.socket.readyState !== WebSocket.OPEN) {
        unsubscribe(subscriber.connId);
        return;
      }
      if (subscriber.socket.bufferedAmount > MAX_BUFFERED_BYTES) {
        unsubscribe(subscriber.connId);
        try {
          subscriber.socket.close(1008, "slow consumer");
        } catch {}
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
      subscriber.file = file;
      subscriber.cursor = result.cursor;
      if (!result.reset && result.lines.length === 0) {
        return;
      }
      subscriber.socket.send(
        JSON.stringify({
          type: "event",
          event: "logs.appended",
          payload: {
            file,
            ...result,
          },
        }),
      );
    } catch {
      unsubscribe(subscriber.connId);
      try {
        if (subscriber.socket.readyState === WebSocket.OPEN) {
          subscriber.socket.close(1011, "log stream error");
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
      subscribers.set(normalizedConnId, {
        connId: normalizedConnId,
        socket: gatewayClient.socket,
        active: opts?.paused !== true,
        file: typeof opts?.file === "string" ? opts.file : undefined,
        cursor: typeof opts?.cursor === "number" ? opts.cursor : undefined,
        limit: typeof opts?.limit === "number" ? opts.limit : 500,
        maxBytes: typeof opts?.maxBytes === "number" ? opts.maxBytes : 250_000,
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

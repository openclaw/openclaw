import { Buffer } from "node:buffer";
import { WebSocket } from "ws";
import {
  registerLogTransport,
  type LogTransportRecord,
  type LogTransport,
} from "../logging/logger.js";
import { formatTimestamp } from "../logging/timestamps.js";
import { MAX_BUFFERED_BYTES } from "./server-constants.js";
import type { GatewayWsClient } from "./server/ws-types.js";

const MAX_RECENT_LOG_BYTES = 1_000_000;
const MAX_RECENT_LOG_AGE_MS = 60_000;
const MAX_SUBSCRIBER_QUEUE_BYTES = 1_000_000;
const MAX_LOG_STREAM_SOCKET_BUFFER_BYTES = Math.min(MAX_BUFFERED_BYTES, 512 * 1024);
const MAX_BATCH_BYTES = 64 * 1024;
const MAX_BATCH_LINES = 128;
const WRITABLE_POLL_MS = 25;
const LOG_STREAM_OVERFLOW_CLOSE_CODE = 1008;
const LOG_STREAM_OVERFLOW_CLOSE_REASON = "log stream overflow";

type LogEntry = {
  line: string;
  bytes: number;
  ts: number;
};

type QueuedBatch = {
  lines: string[];
  bytes: number;
  count: number;
};

type SocketWithWritable = WebSocket & {
  _socket?: {
    once?: (event: string, listener: () => void) => void;
  };
};

type LogSubscriber = {
  connId: string;
  socket: WebSocket;
  active: boolean;
  closed: boolean;
  queue: LogEntry[];
  head: number;
  queuedBytes: number;
  flushing: boolean;
  waitingWritable: boolean;
  writableTimer: NodeJS.Timeout | null;
};

export type GatewayLogStream = {
  subscribe: (connId: string, opts?: { paused?: boolean }) => boolean;
  activate: (connId: string) => void;
  unsubscribe: (connId: string) => void;
  close: () => void;
};

function compactQueue<T>(items: T[], head: number): { items: T[]; head: number } {
  if (head === 0) {
    return { items, head };
  }
  if (head < 1024 && head * 2 < items.length) {
    return { items, head };
  }
  return {
    items: items.slice(head),
    head: 0,
  };
}

function formatLogEntry(record: LogTransportRecord): LogEntry | null {
  try {
    const date = record.date instanceof Date ? record.date : new Date();
    const line = JSON.stringify({
      ...record,
      time: formatTimestamp(date, { style: "long" }),
    });
    return {
      line,
      bytes: Buffer.byteLength(`${line}\n`, "utf8"),
      ts: Date.now(),
    };
  } catch {
    return null;
  }
}

function sendFrame(socket: WebSocket, frame: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    try {
      socket.send(frame, (err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    } catch (err) {
      reject(err);
    }
  });
}

export function createGatewayLogStream(params: {
  getClientByConnId: (connId: string) => GatewayWsClient | undefined;
}): GatewayLogStream {
  const subscribers = new Map<string, LogSubscriber>();
  const recent: LogEntry[] = [];
  let recentHead = 0;
  let recentBytes = 0;

  const trimRecent = () => {
    const cutoff = Date.now() - MAX_RECENT_LOG_AGE_MS;
    while (recentHead < recent.length) {
      const entry = recent[recentHead];
      if (!entry) {
        recentHead += 1;
        continue;
      }
      if (recentBytes <= MAX_RECENT_LOG_BYTES && entry.ts >= cutoff) {
        break;
      }
      recentBytes = Math.max(0, recentBytes - entry.bytes);
      recentHead += 1;
    }
    const compacted = compactQueue(recent, recentHead);
    recent.length = 0;
    recent.push(...compacted.items);
    recentHead = compacted.head;
  };

  const waitForWritable = (subscriber: LogSubscriber) => {
    if (subscriber.waitingWritable || subscriber.closed) {
      return;
    }
    subscriber.waitingWritable = true;
    const resume = () => {
      if (subscribers.get(subscriber.connId) !== subscriber || subscriber.closed) {
        return;
      }
      subscriber.waitingWritable = false;
      if (subscriber.writableTimer) {
        clearTimeout(subscriber.writableTimer);
        subscriber.writableTimer = null;
      }
      if (!subscriber.flushing) {
        subscriber.flushing = true;
        queueMicrotask(() => {
          void flushSubscriber(subscriber);
        });
      }
    };
    const socket = subscriber.socket as SocketWithWritable;
    socket._socket?.once?.("drain", resume);
    subscriber.writableTimer = setTimeout(resume, WRITABLE_POLL_MS);
    subscriber.writableTimer.unref?.();
  };

  const unsubscribe = (connId: string) => {
    const subscriber = subscribers.get(connId);
    if (!subscriber) {
      return;
    }
    subscribers.delete(connId);
    subscriber.closed = true;
    if (subscriber.writableTimer) {
      clearTimeout(subscriber.writableTimer);
      subscriber.writableTimer = null;
    }
    subscriber.queue.length = 0;
    subscriber.head = 0;
    subscriber.queuedBytes = 0;
  };

  const closeSlowSubscriber = (subscriber: LogSubscriber) => {
    unsubscribe(subscriber.connId);
    try {
      subscriber.socket.close(LOG_STREAM_OVERFLOW_CLOSE_CODE, LOG_STREAM_OVERFLOW_CLOSE_REASON);
    } catch {
      // ignore close failures while tearing down slow subscribers
    }
  };

  const consumeBatch = (subscriber: LogSubscriber, batch: QueuedBatch) => {
    subscriber.head += batch.count;
    subscriber.queuedBytes = Math.max(0, subscriber.queuedBytes - batch.bytes);
    const compacted = compactQueue(subscriber.queue, subscriber.head);
    subscriber.queue = compacted.items;
    subscriber.head = compacted.head;
  };

  const buildBatch = (subscriber: LogSubscriber): QueuedBatch | null => {
    if (subscriber.head >= subscriber.queue.length) {
      return null;
    }
    const lines: string[] = [];
    let bytes = 0;
    let count = 0;
    for (let index = subscriber.head; index < subscriber.queue.length; index += 1) {
      const entry = subscriber.queue[index];
      if (!entry) {
        continue;
      }
      if (count > 0 && (count >= MAX_BATCH_LINES || bytes + entry.bytes > MAX_BATCH_BYTES)) {
        break;
      }
      lines.push(entry.line);
      bytes += entry.bytes;
      count += 1;
    }
    if (count === 0) {
      return null;
    }
    return { lines, bytes, count };
  };

  const flushSubscriber = async (subscriber: LogSubscriber): Promise<void> => {
    try {
      while (!subscriber.closed && subscriber.active) {
        if (subscriber.head >= subscriber.queue.length) {
          return;
        }
        if (subscriber.socket.readyState !== WebSocket.OPEN) {
          unsubscribe(subscriber.connId);
          return;
        }
        if (subscriber.socket.bufferedAmount > MAX_LOG_STREAM_SOCKET_BUFFER_BYTES) {
          waitForWritable(subscriber);
          return;
        }
        const batch = buildBatch(subscriber);
        if (!batch) {
          return;
        }
        await sendFrame(
          subscriber.socket,
          JSON.stringify({
            type: "event",
            event: "logs.appended",
            payload: { lines: batch.lines },
          }),
        );
        consumeBatch(subscriber, batch);
      }
    } catch {
      unsubscribe(subscriber.connId);
    } finally {
      subscriber.flushing = false;
      if (
        !subscriber.closed &&
        subscriber.active &&
        subscriber.head < subscriber.queue.length &&
        !subscriber.waitingWritable
      ) {
        subscriber.flushing = true;
        queueMicrotask(() => {
          void flushSubscriber(subscriber);
        });
      }
    }
  };

  const scheduleFlush = (subscriber: LogSubscriber) => {
    if (
      subscriber.closed ||
      !subscriber.active ||
      subscriber.flushing ||
      subscriber.waitingWritable
    ) {
      return;
    }
    subscriber.flushing = true;
    queueMicrotask(() => {
      void flushSubscriber(subscriber);
    });
  };

  const enqueue = (entry: LogEntry) => {
    recent.push(entry);
    recentBytes += entry.bytes;
    trimRecent();

    for (const subscriber of subscribers.values()) {
      if (subscriber.closed) {
        continue;
      }
      subscriber.queue.push(entry);
      subscriber.queuedBytes += entry.bytes;
      if (subscriber.queuedBytes > MAX_SUBSCRIBER_QUEUE_BYTES) {
        closeSlowSubscriber(subscriber);
        continue;
      }
      scheduleFlush(subscriber);
    }
  };

  const transport: LogTransport = (record) => {
    const entry = formatLogEntry(record);
    if (!entry) {
      return;
    }
    enqueue(entry);
  };

  const unregisterTransport = registerLogTransport(transport);

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
      unsubscribe(normalizedConnId);
      subscribers.set(normalizedConnId, {
        connId: normalizedConnId,
        socket: gatewayClient.socket,
        active: opts?.paused !== true,
        closed: false,
        queue: [],
        head: 0,
        queuedBytes: 0,
        flushing: false,
        waitingWritable: false,
        writableTimer: null,
      });
      return true;
    },
    activate: (connId) => {
      const subscriber = subscribers.get(connId.trim());
      if (!subscriber || subscriber.closed) {
        return;
      }
      subscriber.active = true;
      scheduleFlush(subscriber);
    },
    unsubscribe,
    close: () => {
      unregisterTransport();
      while (subscribers.size > 0) {
        const connId = subscribers.keys().next().value;
        if (typeof connId !== "string") {
          break;
        }
        unsubscribe(connId);
      }
      recent.length = 0;
      recentHead = 0;
      recentBytes = 0;
    },
  };
}

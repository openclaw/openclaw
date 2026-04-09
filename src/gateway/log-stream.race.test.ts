import { afterEach, describe, expect, test, vi } from "vitest";
import { WebSocket } from "ws";

const { getResolvedLoggerSettings, resolveLogFile, readLogSlice } = vi.hoisted(() => ({
  getResolvedLoggerSettings: vi.fn(() => ({
    file: "/tmp/openclaw-2026-04-03.log",
  })),
  resolveLogFile: vi.fn(async (file: string) => file),
  readLogSlice: vi.fn(),
}));

vi.mock("../logging.js", () => ({
  getResolvedLoggerSettings: () => getResolvedLoggerSettings(),
}));

vi.mock("./log-tail.js", () => ({
  resolveLogFile,
  readLogSlice,
}));

import { createGatewayLogStream } from "./log-stream.js";

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("createGatewayLogStream unsubscribe race", () => {
  test("does not send appended logs after unsubscribe wins during an in-flight poll", async () => {
    const pendingSlice = createDeferred<{
      cursor: number;
      size: number;
      lines: string[];
      truncated: boolean;
      reset: boolean;
    }>();
    readLogSlice.mockReturnValueOnce(pendingSlice.promise);

    const socket = {
      readyState: WebSocket.OPEN,
      bufferedAmount: 0,
      send: vi.fn(),
      close: vi.fn(),
    };
    const broadcastToConnIds = vi.fn();

    const stream = createGatewayLogStream({
      getClientByConnId: (connId) =>
        connId === "conn-1"
          ? ({
              socket,
            } as never)
          : undefined,
      broadcastToConnIds,
    });

    try {
      expect(stream.subscribe("conn-1", { paused: true })).toBe(true);
      stream.activate("conn-1");
      await Promise.resolve();

      stream.unsubscribe("conn-1");
      pendingSlice.resolve({
        cursor: 42,
        size: 42,
        lines: ["after unsubscribe"],
        truncated: false,
        reset: false,
      });
      await Promise.resolve();
      await Promise.resolve();

      expect(socket.send).not.toHaveBeenCalled();
      expect(broadcastToConnIds).not.toHaveBeenCalled();
    } finally {
      stream.close();
    }
  });

  test("routes appended log events through targeted broadcast delivery", async () => {
    readLogSlice.mockResolvedValueOnce({
      cursor: 7,
      size: 7,
      lines: ["streamed line"],
      truncated: false,
      reset: false,
    });

    const socket = {
      readyState: WebSocket.OPEN,
      bufferedAmount: 0,
      send: vi.fn(),
      close: vi.fn(),
    };
    const broadcastToConnIds = vi.fn();

    const stream = createGatewayLogStream({
      getClientByConnId: (connId) =>
        connId === "conn-1"
          ? ({
              socket,
            } as never)
          : undefined,
      broadcastToConnIds,
    });

    try {
      expect(stream.subscribe("conn-1", { paused: true })).toBe(true);
      stream.activate("conn-1");
      await Promise.resolve();
      await Promise.resolve();

      expect(broadcastToConnIds).toHaveBeenCalledWith(
        "logs.appended",
        expect.objectContaining({
          file: "/tmp/openclaw-2026-04-03.log",
          cursor: 7,
          lines: ["streamed line"],
        }),
        new Set(["conn-1"]),
      );
      expect(socket.send).not.toHaveBeenCalled();
    } finally {
      stream.close();
    }
  });

  test("rejects subscriptions beyond the per-ip cap", () => {
    const sockets = new Map(
      Array.from({ length: 5 }, (_, index) => [
        `conn-${index + 1}`,
        {
          readyState: WebSocket.OPEN,
          bufferedAmount: 0,
          send: vi.fn(),
          close: vi.fn(),
        },
      ]),
    );

    const stream = createGatewayLogStream({
      getClientByConnId: (connId) => {
        const socket = sockets.get(connId);
        if (!socket) {
          return undefined;
        }
        return {
          socket,
          clientIp: "127.0.0.1",
        } as never;
      },
      broadcastToConnIds: vi.fn(),
    });

    try {
      expect(stream.subscribe("conn-1")).toBe(true);
      expect(stream.subscribe("conn-2")).toBe(true);
      expect(stream.subscribe("conn-3")).toBe(true);
      expect(stream.subscribe("conn-4")).toBe(true);
      expect(stream.subscribe("conn-5")).toBe(false);
    } finally {
      stream.close();
    }
  });
});

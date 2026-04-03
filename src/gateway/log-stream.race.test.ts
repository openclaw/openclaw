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

    const stream = createGatewayLogStream({
      getClientByConnId: (connId) =>
        connId === "conn-1"
          ? ({
              socket,
            } as never)
          : undefined,
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
    } finally {
      stream.close();
    }
  });
});

// Covers JSONL socket request framing and response handling.
import { getEventListeners } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import path from "node:path";
import timers from "node:timers";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { requestJsonlSocket } from "./jsonl-socket.js";

async function withSocketServer(
  server: net.Server,
  run: (socketPath: string) => Promise<void>,
): Promise<void> {
  // macOS sockaddr_un cannot hold the test runner's nested temporary path.
  await withTestDir({ prefix: "oc-jsonl-", parentDir: "/tmp" }, async (dir) => {
    const socketPath = path.join(dir, "socket.sock");
    const sockets: net.Socket[] = [];
    const closed: Promise<void>[] = [];
    server.on("connection", (socket) => {
      sockets.push(socket);
      closed.push(
        new Promise<void>((resolve) => {
          socket.once("close", resolve);
        }),
      );
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    try {
      await run(socketPath);
    } finally {
      for (const socket of sockets) {
        socket.destroy();
      }
      await Promise.all(closed);
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
}

// Bind the module's node:timers imports to Vitest's fake clock so deadlines only
// advance when a test says so.
async function withControlledTimers(run: () => Promise<void>): Promise<void> {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const schedule = vi.spyOn(timers, "setTimeout").mockImplementation(setTimeout);
  const clear = vi.spyOn(timers, "clearTimeout").mockImplementation(clearTimeout);
  syncBuiltinESMExports();
  try {
    await run();
  } finally {
    schedule.mockRestore();
    clear.mockRestore();
    vi.useRealTimers();
    syncBuiltinESMExports();
  }
}

function acceptDoneValue(msg: unknown): number | null | undefined {
  const value = msg as { type?: string; value?: number };
  return value.type === "done" ? (value.value ?? null) : undefined;
}

describe.runIf(process.platform !== "win32")("requestJsonlSocket", () => {
  it("ignores malformed and non-accepted lines until one is accepted", async () => {
    const server = net.createServer((socket) => {
      socket.on("data", () => {
        socket.write("{bad json}\n");
        socket.write('{"type":"ignore"}\n');
        socket.write('{"type":"done","value":42}\n');
      });
    });
    await withSocketServer(server, async (socketPath) => {
      await expect(
        requestJsonlSocket({
          socketPath,
          requestLine: '{"hello":"world"}',
          timeoutMs: 500,
          accept: acceptDoneValue,
        }),
      ).resolves.toBe(42);
    });
  });

  it("does not connect or send an already-aborted request", async () => {
    const connected = vi.fn();
    const server = net.createServer((socket) => {
      connected();
      socket.resume();
      socket.on("end", () => socket.end('{"type":"done","value":7}\n'));
    });
    await withSocketServer(server, async (socketPath) => {
      await expect(
        requestJsonlSocket({
          socketPath,
          requestLine: '{"hello":"world"}',
          timeoutMs: 500,
          accept: acceptDoneValue,
          signal: AbortSignal.abort(),
        }),
      ).resolves.toBeNull();
      expect(connected).not.toHaveBeenCalled();
    });
  });

  it.each([false, true])("half-closes the request and settles after abort=%s", async (abort) => {
    const received = createDeferred<{ socket: net.Socket; buffer: string }>();
    const server = net.createServer({ allowHalfOpen: true }, (socket) => {
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
      });
      socket.on("end", () => received.resolve({ socket, buffer }));
    });
    await withSocketServer(server, async (socketPath) => {
      const controller = new AbortController();
      const completed = vi.fn();
      const pending = requestJsonlSocket({
        socketPath,
        requestLine: '{"hello":"world"}',
        timeoutMs: 0,
        accept: acceptDoneValue,
        signal: controller.signal,
      }).then(completed);
      try {
        const { socket, buffer } = await received.promise;
        expect(buffer).toBe('{"hello":"world"}\n');
        expect(completed).not.toHaveBeenCalled();
        if (abort) {
          controller.abort();
          await expect.poll(() => completed.mock.calls.length, { timeout: 1_000 }).toBe(1);
          expect(completed).toHaveBeenCalledWith(null);
          // EOF already arrived from the normal half-close. A failed peer write
          // proves cancellation also closed the client's remaining read side.
          const writeError = vi.fn();
          socket.once("error", writeError);
          socket.write('{"type":"done","value":7}\n');
          await expect.poll(() => writeError.mock.calls.length, { timeout: 1_000 }).toBe(1);
          expect(writeError).toHaveBeenCalledWith(expect.objectContaining({ code: "EPIPE" }));
        } else {
          socket.end('{"type":"done","value":7}\n');
          await pending;
          expect(completed).toHaveBeenCalledWith(7);
        }
        expect(getEventListeners(controller.signal, "abort")).toEqual([]);
      } finally {
        controller.abort();
        await pending;
      }
    });
  });

  it("returns null on timeout and on socket errors", async () => {
    let closedSocketPath = "";
    const server = net.createServer({ allowHalfOpen: true }, (socket) => {
      socket.resume();
      // Intentionally keep the response side open after the request half-close.
    });
    await withSocketServer(server, async (socketPath) => {
      closedSocketPath = socketPath;
      await expect(
        requestJsonlSocket({
          socketPath,
          requestLine: "{}",
          timeoutMs: 50,
          accept: () => undefined,
        }),
      ).resolves.toBeNull();
    });
    await expect(
      requestJsonlSocket({
        socketPath: closedSocketPath,
        requestLine: "{}",
        timeoutMs: 50,
        accept: () => undefined,
      }),
    ).resolves.toBeNull();
  });

  it("returns the caller's typed timeout result after the request is submitted", async () => {
    const received = createDeferred();
    const server = net.createServer({ allowHalfOpen: true }, (socket) => {
      socket.resume();
      // Keep the response side open after the request half-close.
      socket.on("end", () => received.resolve());
    });
    await withSocketServer(server, async (socketPath) => {
      await withControlledTimers(async () => {
        const completed = vi.fn();
        const pending = requestJsonlSocket({
          socketPath,
          requestLine: "{}",
          timeoutMs: 50,
          onTimeout: () => ({ kind: "timeout" as const }),
          accept: () => undefined,
        }).then(completed);
        await received.promise;
        await vi.advanceTimersByTimeAsync(49);
        expect(completed).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        await pending;
        expect(completed).toHaveBeenCalledWith({ kind: "timeout" });
      });
    });
  });

  it("returns the caller's typed response-loss result after submission", async () => {
    const server = net.createServer((socket) => {
      socket.on("data", () => {
        socket.destroy();
      });
    });
    await withSocketServer(server, async (socketPath) => {
      await expect(
        requestJsonlSocket({
          socketPath,
          requestLine: "{}",
          timeoutMs: 500,
          onResponseLost: () => ({ kind: "response-lost" as const }),
          accept: () => undefined,
        }),
      ).resolves.toEqual({ kind: "response-lost" });
    });
  });

  it("classifies an oversized reply as response loss after submission", async () => {
    const server = net.createServer((socket) => {
      socket.on("error", () => {});
      socket.on("data", () => socket.end("x".repeat(16 * 1024 * 1024 + 1)));
    });
    await withSocketServer(server, async (socketPath) => {
      await expect(
        requestJsonlSocket({
          socketPath,
          requestLine: "{}",
          timeoutMs: 0,
          onResponseLost: () => ({ kind: "response-lost" as const }),
          accept: () => undefined,
        }),
      ).resolves.toEqual({ kind: "response-lost" });
    });
  });

  it("can wait without a transport deadline when timeoutMs is zero", async () => {
    const received = createDeferred<net.Socket>();
    const server = net.createServer({ allowHalfOpen: true }, (socket) => {
      socket.resume();
      socket.on("end", () => received.resolve(socket));
    });
    await withSocketServer(server, async (socketPath) => {
      await withControlledTimers(async () => {
        const completed = vi.fn();
        const pending = requestJsonlSocket<number | { kind: "timeout" }>({
          socketPath,
          requestLine: "{}",
          timeoutMs: 0,
          onTimeout: () => ({ kind: "timeout" as const }),
          accept: acceptDoneValue,
        }).then(completed);
        const socket = await received.promise;
        expect(vi.getTimerCount()).toBe(0);
        await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
        expect(completed).not.toHaveBeenCalled();
        socket.end('{"type":"done","value":7}\n');
        await pending;
        expect(completed).toHaveBeenCalledWith(7);
      });
    });
  });

  it("returns null when the socket closes without an accepted response", async () => {
    const server = net.createServer((socket) => {
      socket.on("data", () => {
        socket.destroy();
      });
    });
    await withSocketServer(server, async (socketPath) => {
      // Leave the deadline frozen: only the real socket close can settle this request.
      await withControlledTimers(async () => {
        const pending = requestJsonlSocket({
          socketPath,
          requestLine: "{}",
          timeoutMs: 250,
          accept: () => undefined,
        });
        expect(vi.getTimerCount()).toBe(1);
        await expect(pending).resolves.toBeNull();
        expect(vi.getTimerCount()).toBe(0);
      });
    });
  });
});

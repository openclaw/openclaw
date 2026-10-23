import { getEventListeners } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import path from "node:path";
import timers from "node:timers";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { requestExecHostViaSocket } from "./exec-host.js";
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

const token = "exec-host-framing-test-token";
const request = { command: ["echo", "hi"] };
function requestExec(
  socketPath: string,
  options: Partial<Parameters<typeof requestExecHostViaSocket>[0]> = {},
) {
  return requestExecHostViaSocket({ socketPath, token, request, timeoutMs: 500, ...options });
}
function waitingServer() {
  const received = createDeferred<net.Socket>();
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    socket.resume();
    socket.on("end", () => received.resolve(socket));
  });
  return { received, server };
}
const success = {
  ok: true,
  payload: { timedOut: false, success: true, stdout: "done", stderr: "" },
};
const denial = { ok: false, error: { code: "DENIED", message: "Denied by host policy" } };
const timeoutResponse = {
  ok: false,
  error: {
    code: "TIMEOUT",
    reason: "timeout",
    message: "TIMEOUT: macOS app exec host response timed out; execution outcome is unknown",
  },
};
const responseLost = {
  ok: false,
  error: {
    code: "UNKNOWN",
    reason: "response-lost",
    message: "UNKNOWN: macOS app exec host response was lost; execution outcome is unknown",
  },
};

describe.runIf(process.platform !== "win32")("exec host JSONL framing", () => {
  it.each([success, denial])(
    "ignores malformed, incomplete, and unrelated lines before an exec response: $ok",
    async (response) => {
      const server = net.createServer((socket) => {
        socket.on("data", () => {
          socket.write("\n{bad json}\nnull\n");
          socket.write('{"type":"ignore"}\n');
          socket.write('{"type":"exec-res","ok":true}\n');
          socket.write(JSON.stringify({ type: "exec-res", ...response }) + "\n");
        });
      });
      await withSocketServer(server, async (socketPath) => {
        await expect(requestExec(socketPath)).resolves.toEqual(response);
      });
    },
  );

  it("preserves UTF-8 code points split between socket chunks", async () => {
    const response = {
      ok: true,
      payload: { timedOut: false, success: true, stdout: "before 🦞 after", stderr: "" },
    };
    const frame = Buffer.from(JSON.stringify({ type: "exec-res", ...response }) + "\n");
    const split = frame.indexOf(Buffer.from("🦞")) + 2;
    const server = net.createServer({ allowHalfOpen: true }, (socket) => {
      socket.on("data", () => {
        socket.write(frame.subarray(0, split));
        setImmediate(() => socket.end(frame.subarray(split)));
      });
    });
    await withSocketServer(server, async (socketPath) => {
      await expect(requestExec(socketPath)).resolves.toEqual(response);
    });
  });

  it("does not connect or send an already-aborted request", async () => {
    const connected = vi.fn();
    const server = net.createServer((socket) => {
      connected();
      socket.resume();
      socket.on("end", () => socket.end(JSON.stringify({ type: "exec-res", ...success }) + "\n"));
    });
    await withSocketServer(server, async (socketPath) => {
      await expect(requestExec(socketPath, { signal: AbortSignal.abort() })).resolves.toBeNull();
      expect(connected).not.toHaveBeenCalled();
    });
  });

  it("rechecks effect authority after connect and rejects without dispatch", async () => {
    const received: Buffer[] = [];
    const server = net.createServer((socket) => {
      socket.on("data", (chunk) =>
        received.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk),
      );
    });
    await withSocketServer(server, async (socketPath) => {
      let current = true;
      const pending = requestJsonlSocket({
        socketPath,
        requestLine: "{}",
        timeoutMs: 500,
        accept: () => undefined,
        beforeSend() {
          if (!current) {
            throw new Error("authority revoked");
          }
        },
      });
      current = false;
      await expect(pending).rejects.toThrow("authority revoked");
    });
    expect(received).toEqual([]);
  });

  it("treats a caller-bounded oversized reply as terminal response loss", async () => {
    const server = net.createServer((socket) => {
      socket.on("error", () => {});
      socket.on("data", () => socket.end(JSON.stringify({ padding: "x".repeat(128) }) + "\n"));
    });
    await withSocketServer(server, async (socketPath) => {
      await expect(
        requestJsonlSocket({
          socketPath,
          requestLine: "{}",
          timeoutMs: 500,
          maxResponseLineBytes: 64,
          accept: () => undefined,
          onResponseLost: () => ({ kind: "lost" }),
        }),
      ).resolves.toEqual({ kind: "lost" });
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
      const pending = requestExec(socketPath, { timeoutMs: 0, signal: controller.signal }).then(
        completed,
      );
      try {
        const { socket, buffer } = await received.promise;
        expect(buffer.endsWith("\n")).toBe(true);
        expect(buffer.trim().split("\n")).toHaveLength(1);
        expect(JSON.parse(buffer)).toMatchObject({
          type: "exec",
          requestJson: '{"command":["echo","hi"]}',
        });
        expect(completed).not.toHaveBeenCalled();
        if (abort) {
          controller.abort();
          await expect.poll(() => completed.mock.calls.length, { timeout: 1_000 }).toBe(1);
          expect(completed).toHaveBeenCalledWith(null);
          // EOF already arrived from the normal half-close. A failed peer write
          // proves cancellation also closed the client's remaining read side.
          const writeError = vi.fn();
          socket.once("error", writeError);
          socket.write(JSON.stringify({ type: "exec-res", ...success }) + "\n");
          await expect.poll(() => writeError.mock.calls.length, { timeout: 1_000 }).toBe(1);
          expect(writeError).toHaveBeenCalledWith(expect.objectContaining({ code: "EPIPE" }));
        } else {
          socket.end(JSON.stringify({ type: "exec-res", ...success }) + "\n");
          await pending;
          expect(completed).toHaveBeenCalledWith(success);
        }
        expect(getEventListeners(controller.signal, "abort")).toEqual([]);
      } finally {
        controller.abort();
        await pending;
      }
    });
  });

  it("returns a timeout outcome after the request is submitted", async () => {
    const { received, server } = waitingServer();
    await withSocketServer(server, async (socketPath) => {
      await withControlledTimers(async () => {
        const completed = vi.fn();
        const pending = requestExec(socketPath, { timeoutMs: 50 }).then(completed);
        await received.promise;
        await vi.advanceTimersByTimeAsync(49);
        expect(completed).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        await pending;
        expect(completed).toHaveBeenCalledWith(timeoutResponse);
      });
    });
  });

  it.each([
    { commandTimeoutMs: 30_000, responseTimeoutMs: 50_000 },
    { commandTimeoutMs: 1_000, responseTimeoutMs: 21_000 },
    { commandTimeoutMs: undefined, responseTimeoutMs: 20_000 },
  ])(
    "derives the response deadline from command timeout $commandTimeoutMs",
    async ({ commandTimeoutMs, responseTimeoutMs }) => {
      const { received, server } = waitingServer();
      await withSocketServer(server, async (socketPath) => {
        await withControlledTimers(async () => {
          const completed = vi.fn();
          const pending = requestExec(socketPath, {
            request: { ...request, timeoutMs: commandTimeoutMs },
            timeoutMs: undefined,
          }).then(completed);
          await received.promise;
          await vi.advanceTimersByTimeAsync(responseTimeoutMs - 1);
          expect(completed).not.toHaveBeenCalled();
          await vi.advanceTimersByTimeAsync(1);
          await pending;
          expect(completed).toHaveBeenCalledWith(timeoutResponse);
        });
      });
    },
  );

  it("classifies an oversized reply as response loss after submission", async () => {
    const server = net.createServer({ allowHalfOpen: true }, (socket) => {
      socket.on("error", () => {});
      // Leave the response open: the byte bound, not peer EOF, must settle the request.
      socket.on("data", () => socket.write("x".repeat(16 * 1024 * 1024 + 1)));
    });
    await withSocketServer(server, async (socketPath) => {
      await expect(requestExec(socketPath, { timeoutMs: 0 })).resolves.toEqual(responseLost);
    });
  });

  it("can wait without a transport deadline when command timeoutMs is zero", async () => {
    const { received, server } = waitingServer();
    await withSocketServer(server, async (socketPath) => {
      await withControlledTimers(async () => {
        const completed = vi.fn();
        const pending = requestExec(socketPath, {
          request: { ...request, timeoutMs: 0 },
          timeoutMs: undefined,
        }).then(completed);
        const socket = await received.promise;
        expect(vi.getTimerCount()).toBe(0);
        await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
        expect(completed).not.toHaveBeenCalled();
        socket.end(JSON.stringify({ type: "exec-res", ...success }) + "\n");
        await pending;
        expect(completed).toHaveBeenCalledWith(success);
      });
    });
  });

  it("settles response loss without waiting for the deadline and clears its timer", async () => {
    const server = net.createServer((socket) => {
      socket.on("data", () => {
        socket.destroy();
      });
    });
    await withSocketServer(server, async (socketPath) => {
      // Leave the deadline frozen: only the real socket close can settle this request.
      await withControlledTimers(async () => {
        const pending = requestExec(socketPath, { timeoutMs: 250 });
        expect(vi.getTimerCount()).toBe(1);
        await expect(pending).resolves.toEqual(responseLost);
        expect(vi.getTimerCount()).toBe(0);
      });
    });
  });
});

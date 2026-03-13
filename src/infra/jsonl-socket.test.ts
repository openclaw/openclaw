import net from "node:net";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempDir } from "../test-helpers/temp-dir.js";
import { requestJsonlSocket } from "./jsonl-socket.js";

describe.runIf(process.platform !== "win32")("requestJsonlSocket", () => {
  it("ignores malformed and non-accepted lines until one is accepted", async () => {
    await withTempDir({ prefix: "openclaw-jsonl-socket-" }, async (dir) => {
      const socketPath = path.join(dir, "socket.sock");
      const server = net.createServer((socket) => {
        socket.on("data", () => {
          socket.write("{bad json}\n");
          socket.write('{"type":"ignore"}\n');
          socket.write('{"type":"done","value":42}\n');
        });
      });
      await new Promise<void>((resolve) => server.listen(socketPath, resolve));

      try {
        await expect(
          requestJsonlSocket({
            socketPath,
            payload: '{"hello":"world"}',
            timeoutMs: 500,
            accept: (msg) => {
              const value = msg as { type?: string; value?: number };
              return value.type === "done" ? (value.value ?? null) : undefined;
            },
          }),
        ).resolves.toBe(42);
      } finally {
        server.close();
      }
    });
  });

  it("returns null on timeout and on socket errors", async () => {
    await withTempDir({ prefix: "openclaw-jsonl-socket-" }, async (dir) => {
      const socketPath = path.join(dir, "socket.sock");
      const server = net.createServer(() => {
        // Intentionally never reply.
      });
      await new Promise<void>((resolve) => server.listen(socketPath, resolve));

      try {
        await expect(
          requestJsonlSocket({
            socketPath,
            payload: "{}",
            timeoutMs: 50,
            accept: () => undefined,
          }),
        ).resolves.toBeNull();
      } finally {
        server.close();
      }

      await expect(
        requestJsonlSocket({
          socketPath,
          payload: "{}",
          timeoutMs: 50,
          accept: () => undefined,
        }),
      ).resolves.toBeNull();
    });
  });
});

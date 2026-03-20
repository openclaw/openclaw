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

  it("handles multi-byte UTF-8 characters split across TCP chunks", async () => {
    await withTempDir({ prefix: "openclaw-jsonl-socket-" }, async (dir) => {
      const socketPath = path.join(dir, "socket.sock");
      // "你好" in UTF-8 is 6 bytes: e4 bd a0 e5 a5 bd
      // We split the JSON line so the first chunk ends mid-character.
      const fullLine = '{"text":"你好"}\n';
      const fullBuf = Buffer.from(fullLine, "utf8");
      // Split inside the second character (after first byte of 好)
      const splitPoint = fullBuf.indexOf(0xa5); // second byte of 好 (e5 a5 bd)
      const chunk1 = fullBuf.subarray(0, splitPoint);
      const chunk2 = fullBuf.subarray(splitPoint);

      const server = net.createServer((socket) => {
        socket.on("data", () => {
          // Send the two halves separately to simulate a TCP chunk boundary
          // landing in the middle of a multi-byte UTF-8 sequence.
          socket.write(chunk1);
          setTimeout(() => socket.write(chunk2), 10);
        });
      });
      await new Promise<void>((resolve) => server.listen(socketPath, resolve));

      try {
        const result = await requestJsonlSocket({
          socketPath,
          payload: "{}",
          timeoutMs: 2000,
          accept: (msg) => {
            const value = msg as { text?: string };
            return value.text ?? null;
          },
        });
        expect(result).toBe("你好");
        // Verify no U+FFFD replacement character
        expect(result).not.toContain("\uFFFD");
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

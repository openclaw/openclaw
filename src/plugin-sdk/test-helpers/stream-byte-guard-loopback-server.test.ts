// Consumer tests for the loopback byte-stream server helper.
//
// These tests exist to prove the helper actually works (address resolution,
// chunked streaming, request-close handling, error paths) so future SSE/stream
// bounded-read PRs can rely on the helper without re-validating it themselves.
import { describe, expect, it } from "vitest";
import { startLoopbackByteStreamServer } from "./stream-byte-guard-loopback-server.ts";

describe("startLoopbackByteStreamServer", () => {
  it("streams the full body when the caller drains to completion", async () => {
    const server = await startLoopbackByteStreamServer({
      chunkSize: 64 * 1024,
      totalChunks: 8,
      chunkDelayMs: 0,
      contentType: "application/octet-stream",
    });
    try {
      const response = await fetch(server.url("/api/test"));
      expect(response.status).toBe(200);
      expect(response.headers.get("transfer-encoding")).toBe("chunked");
      if (!response.body) {
        throw new Error("expected response body");
      }
      const reader = response.body.getReader();
      let total = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        if (value) {
          total += value.byteLength;
        }
      }
      // 64 KiB * 8 = 512 KiB
      expect(total).toBe(8 * 64 * 1024);
      const stats = server.getStats();
      expect(stats.bytesSent).toBe(8 * 64 * 1024);
      expect(stats.connectionAborted).toBe(false);
    } finally {
      await server.close();
    }
  });

  it("stops streaming when the caller aborts before draining", async () => {
    const server = await startLoopbackByteStreamServer({
      chunkSize: 64 * 1024,
      totalChunks: 1_000_000,
      chunkDelayMs: 1,
    });
    try {
      const ac = new AbortController();
      const fetchPromise = fetch(server.url(), { signal: ac.signal });
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 5);
      });
      ac.abort();
      let thrown: unknown;
      try {
        const response = await fetchPromise;
        if (!response.body) {
          throw new Error("expected response body");
        }
        const reader = response.body.getReader();
        while (true) {
          const { done } = await reader.read();
          if (done) {
            break;
          }
        }
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeDefined();
      // Give the server a moment to register the close.
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 20);
      });
      const stats = server.getStats();
      expect(stats.requestClosed).toBe(true);
      expect(stats.connectionAborted).toBe(true);
      expect(stats.bytesSent).toBeLessThan(1_000_000 * 64 * 1024);
    } finally {
      await server.close();
    }
  });

  it("close() is idempotent and resolves cleanly", async () => {
    const server = await startLoopbackByteStreamServer({
      chunkSize: 1024,
      totalChunks: 4,
      chunkDelayMs: 0,
    });
    await server.close();
    await expect(server.close()).resolves.toBeUndefined();
  });
});

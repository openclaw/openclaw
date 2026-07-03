// Plugin SDK test helper for streaming byte-bounded-read proof loops.
//
// Spawns a real `node:http` server on 127.0.0.1:0 that streams an
// arbitrary-sized response body with Transfer-Encoding: chunked, then
// exposes its listening URL plus `getStats()` and `close()` via the
// returned server handle. The caller can attach a fetch loopback and
// verify that a bounded reader cancels the stream before the full body
// arrives.
//
// This consolidates the inline `http.createServer` boilerplate that
// every SSE/stream bounded-read PR (`#96607`, `#96701`, `#96762`,
// `#96768`, `#96989`, `#97628`) has been copy-pasting for ~75 lines
// each. After this helper ships, future PRs use one function call.

import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/** Counters exposed to the test for invariant assertions. */
export interface LoopbackByteStreamStats {
  bytesSent: number;
  connectionAborted: boolean;
  requestClosed: boolean;
}

/** Lifecycle handle returned by `startLoopbackByteStreamServer`. */
export interface LoopbackByteStreamServer {
  /** The base URL (`http://127.0.0.1:<port>`). Pass a path suffix if needed. */
  url(path?: string): string;
  /** The TCP port the ephemeral server is listening on. */
  port: number;
  /** The underlying `node:http.Server` (escape hatch; not normally needed). */
  server: Server;
  /** Snapshot the current stream stats (mutates a fresh object — no shared state aliasing). */
  getStats(): LoopbackByteStreamStats;
  /** Stop the server cleanly. Always call this in a finally {} block. */
  close(): Promise<void>;
}

export interface LoopbackByteStreamOptions {
  /** Bytes per `res.write()` call. Default: `1024 * 1024` (1 MiB). */
  chunkSize?: number;
  /** Number of chunks the server attempts to send. Default: `64` (=> 64 MiB at 1 MiB chunks). */
  totalChunks?: number;
  /** Inter-chunk delay in ms (backpressure simulator). Default: `1`. */
  chunkDelayMs?: number;
  /** `Content-Type` header value. Default: `"application/octet-stream"`. */
  contentType?: string;
}

/**
 * Run a Layer 3 (real TCP) loopback proof for SSE/NDJSON byte-bounded
 * readers. The server streams `chunkSize * totalChunks` bytes with
 * `Transfer-Encoding: chunked` to make the body length unknown up
 * front. The returned server handle exposes `url()`, `getStats()`, and
 * `close()` so callers can attach a fetch loopback and verify bounded
 * reader behavior.
 *
 * The helper stops cleanly when the body fully drains OR the request
 * is aborted (the bounded reader's `.cancel()` will trigger `req`'s
 * close handler). Callers must always `close()` in a `finally {}`.
 *
 * @example
 *   const server = await startLoopbackByteStreamServer({ chunkSize: 1024 * 1024 });
 *   try {
 *     await driveOversizedFetch(server.url(), 16 * 1024 * 1024);
 *     const stats = server.getStats();
 *     expect(stats.connectionAborted).toBe(true);
 *   } finally {
 *     await server.close();
 *   }
 */
export async function startLoopbackByteStreamServer(
  options: LoopbackByteStreamOptions = {},
): Promise<LoopbackByteStreamServer> {
  const chunkSize = options.chunkSize ?? 1024 * 1024;
  const totalChunks = options.totalChunks ?? 64;
  const chunkDelayMs = options.chunkDelayMs ?? 1;
  const contentType = options.contentType ?? "application/octet-stream";

  const stats: LoopbackByteStreamStats = {
    bytesSent: 0,
    connectionAborted: false,
    requestClosed: false,
  };

  let interval: ReturnType<typeof setInterval> | undefined;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    res.writeHead(200, {
      "Content-Type": contentType,
      "Transfer-Encoding": "chunked",
    });
    let i = 0;
    interval = setInterval(() => {
      if (i >= totalChunks) {
        if (interval) {
          clearInterval(interval);
        }
        res.end();
        return;
      }
      i += 1;
      stats.bytesSent += chunkSize;
      res.write(new Uint8Array(chunkSize));
    }, chunkDelayMs);

    // Track whether the caller (or the bounded reader's `.cancel()`) aborted
    // the request before the body fully drained. `req.on("close")` fires in
    // both the normal-completion and the aborted paths, so we narrow on
    // `req.aborted` to distinguish them.
    req.on("aborted", () => {
      stats.connectionAborted = true;
      if (interval) {
        clearInterval(interval);
        interval = undefined;
      }
    });
    req.on("close", () => {
      stats.requestClosed = true;
      if (interval) {
        clearInterval(interval);
        interval = undefined;
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address() as AddressInfo | null;
  if (!address) {
    throw new Error("loopback byte-stream server missing address");
  }

  return {
    url(path = "/") {
      return `http://127.0.0.1:${address.port}${path}`;
    },
    port: address.port,
    server,
    getStats() {
      return { ...stats };
    },
    async close() {
      if (interval) {
        clearInterval(interval);
      }
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
  };
}

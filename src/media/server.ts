import fs from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { danger } from "../globals.js";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";
import { detectMime } from "./mime.js";
import {
  cleanOldMedia,
  getMediaDir,
  isSafeOpenError,
  MEDIA_MAX_BYTES,
  readFileWithinRoot,
} from "./server.runtime.js";

const DEFAULT_TTL_MS = 2 * 60 * 1000;
const MAX_MEDIA_ID_CHARS = 200;
const MEDIA_ID_PATTERN = /^[\p{L}\p{N}._-]+$/u;
const MAX_MEDIA_BYTES = MEDIA_MAX_BYTES;

const isValidMediaId = (id: string) => {
  if (!id) {
    return false;
  }
  if (id.length > MAX_MEDIA_ID_CHARS) {
    return false;
  }
  if (id === "." || id === "..") {
    return false;
  }
  return MEDIA_ID_PATTERN.test(id);
};

function sendText(res: ServerResponse, statusCode: number, body: string): void {
  res.statusCode = statusCode;
  res.end(body);
}

function resolveMediaId(req: IncomingMessage): { routeMatched: boolean; id?: string } {
  if (req.method !== "GET") {
    return { routeMatched: false };
  }
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const prefix = "/media/";
  if (!url.pathname.startsWith(prefix)) {
    return { routeMatched: false };
  }
  const encodedId = url.pathname.slice(prefix.length);
  if (!encodedId || encodedId.includes("/")) {
    return { routeMatched: false };
  }
  try {
    return { routeMatched: true, id: decodeURIComponent(encodedId) };
  } catch {
    return { routeMatched: true, id: "" };
  }
}

export function createMediaRequestHandler(ttlMs = DEFAULT_TTL_MS) {
  const mediaDir = getMediaDir();

  return (req: IncomingMessage, res: ServerResponse) => {
    const route = resolveMediaId(req);
    if (!route.routeMatched) {
      sendText(res, 404, "not found");
      return;
    }

    void (async () => {
      res.setHeader("X-Content-Type-Options", "nosniff");
      const id = route.id ?? "";
      if (!isValidMediaId(id)) {
        sendText(res, 400, "invalid path");
        return;
      }
      try {
        const {
          buffer: data,
          realPath,
          stat,
        } = await readFileWithinRoot({
          rootDir: mediaDir,
          relativePath: id,
          maxBytes: MAX_MEDIA_BYTES,
        });
        if (Date.now() - stat.mtimeMs > ttlMs) {
          await fs.rm(realPath).catch(() => {});
          sendText(res, 410, "expired");
          return;
        }
        const mime = await detectMime({ buffer: data, filePath: realPath });
        if (mime) {
          res.setHeader("Content-Type", mime);
        }
        res.statusCode = 200;
        res.end(data);
        // best-effort single-use cleanup after response ends
        res.on("finish", () => {
          const cleanup = () => {
            void fs.rm(realPath).catch(() => {});
          };
          // Tests should not pay for time-based cleanup delays.
          if (process.env.VITEST || process.env.NODE_ENV === "test") {
            queueMicrotask(cleanup);
            return;
          }
          setTimeout(cleanup, 50);
        });
      } catch (err) {
        if (isSafeOpenError(err)) {
          if (err.code === "outside-workspace") {
            sendText(res, 400, "file is outside workspace root");
            return;
          }
          if (err.code === "invalid-path") {
            sendText(res, 400, "invalid path");
            return;
          }
          if (err.code === "not-found") {
            sendText(res, 404, "not found");
            return;
          }
          if (err.code === "too-large") {
            sendText(res, 413, "too large");
            return;
          }
        }
        sendText(res, 404, "not found");
      }
    })().catch(() => {
      if (!res.headersSent) {
        sendText(res, 404, "not found");
      } else {
        res.destroy();
      }
    });
  };
}

function startMediaCleanupInterval(ttlMs: number): void {
  // periodic cleanup
  setInterval(() => {
    void cleanOldMedia(ttlMs, { recursive: false });
  }, ttlMs).unref();
}

export async function startMediaServer(
  port: number,
  ttlMs = DEFAULT_TTL_MS,
  runtime: RuntimeEnv = defaultRuntime,
): Promise<Server> {
  const server = createServer(createMediaRequestHandler(ttlMs));
  startMediaCleanupInterval(ttlMs);
  return await new Promise((resolve, reject) => {
    server.listen(port, "127.0.0.1");
    server.once("listening", () => resolve(server));
    server.once("error", (err) => {
      runtime.error(danger(`Media server failed: ${String(err)}`));
      reject(err);
    });
  });
}

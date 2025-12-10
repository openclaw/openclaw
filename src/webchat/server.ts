import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../config/config.js";
import { logDebug, logError } from "../logger.js";

const WEBCHAT_DEFAULT_PORT = 18788;

type WebChatServerState = {
  server: http.Server;
  port: number;
};

let state: WebChatServerState | null = null;

function resolveWebRoot() {
  const here = path.dirname(fileURLToPath(import.meta.url));

  const candidates = [
    // Bundled inside Clawdis.app: .../Contents/Resources/WebChat
    path.resolve(here, "../../../WebChat"),
    // When running from repo without bundling
    path.resolve(here, "../../WebChat"),
    // Fallback to source tree location
    path.resolve(here, "../../apps/macos/Sources/Clawdis/Resources/WebChat"),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  throw new Error(`webchat assets not found; tried: ${candidates.join(", ")}`);
}

function notFound(res: http.ServerResponse) {
  res.statusCode = 404;
  res.end("Not Found");
}

export async function startWebChatServer(
  port = WEBCHAT_DEFAULT_PORT,
): Promise<WebChatServerState | null> {
  if (state) return state;

  const root = resolveWebRoot();

  const server = http.createServer(async (req, res) => {
    if (!req.url) return notFound(res);
    if (
      req.socket.remoteAddress &&
      !req.socket.remoteAddress.startsWith("127.")
    ) {
      res.statusCode = 403;
      res.end("loopback only");
      return;
    }

    const url = new URL(req.url, "http://127.0.0.1");

    if (url.pathname === "/webchat" || url.pathname.startsWith("/webchat/")) {
      let rel = url.pathname.replace(/^\/webchat\/?/, "");
      if (!rel || rel.endsWith("/")) rel = `${rel}index.html`;
      const filePath = path.join(root, rel);
      if (!filePath.startsWith(root) || !fs.existsSync(filePath)) {
        return notFound(res);
      }
      const data = fs.readFileSync(filePath);
      const ext = path.extname(filePath).toLowerCase();
      const type =
        ext === ".html"
          ? "text/html"
          : ext === ".js"
            ? "application/javascript"
            : ext === ".css"
              ? "text/css"
              : "application/octet-stream";
      res.setHeader("Content-Type", type);
      res.end(data);
      return;
    }

    if (url.pathname === "/") {
      const filePath = path.join(root, "index.html");
      const data = fs.readFileSync(filePath);
      res.setHeader("Content-Type", "text/html");
      res.end(data);
      return;
    }

    const relPath = url.pathname.replace(/^\//, "");
    if (relPath) {
      const filePath = path.join(root, relPath);
      if (filePath.startsWith(root) && fs.existsSync(filePath)) {
        const data = fs.readFileSync(filePath);
        res.setHeader("Content-Type", "application/octet-stream");
        res.end(data);
        return;
      }
    }

    notFound(res);
  });

  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => reject(err);
      server.once("error", onError);
      server.listen(port, "127.0.0.1", () => {
        server.off("error", onError);
        resolve();
      });
    });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    const msg = code ? `${code}: ${String(err)}` : String(err);
    logError(
      `webchat server failed to bind 127.0.0.1:${port} (${msg}); continuing without webchat`,
    );
    return null;
  }

  state = { server, port };
  logDebug(`webchat server listening on 127.0.0.1:${port}`);
  return state;
}

export async function stopWebChatServer() {
  if (!state) return;
  if (state.server) {
    await new Promise<void>((resolve) => state?.server.close(() => resolve()));
  }
  state = null;
}

// Legacy no-op: gateway readiness is now handled directly by clients.
export async function waitForWebChatGatewayReady() {
  return;
}

export function __forceWebChatSnapshotForTests() {
  // no-op: snapshots now come from the Gateway WS directly.
}

export async function __broadcastGatewayEventForTests() {
  // no-op
}

export async function ensureWebChatServerFromConfig() {
  const cfg = loadConfig();
  if (cfg.webchat?.enabled === false) return null;
  const port = cfg.webchat?.port ?? WEBCHAT_DEFAULT_PORT;
  try {
    return await startWebChatServer(port);
  } catch (err) {
    logDebug(`webchat server failed to start: ${String(err)}`);
    throw err;
  }
}

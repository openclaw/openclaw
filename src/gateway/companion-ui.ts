import fs from "node:fs";
import { createServer, type Server as HttpServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

function resolveCompanionUiRoot(): string | null {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const execDir = (() => {
    try {
      return path.dirname(fs.realpathSync(process.execPath));
    } catch {
      return null;
    }
  })();
  const candidates = [
    execDir ? path.resolve(execDir, "companion") : null,
    path.resolve(here, "../companion"),
    path.resolve(here, "../../dist/companion"),
    path.resolve(process.cwd(), "dist", "companion"),
  ].filter((dir): dir is string => Boolean(dir));
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, "index.html"))) return dir;
  }
  return null;
}

function contentTypeForExt(ext: string): string {
  switch (ext) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "application/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".json":
    case ".map":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".ico":
      return "image/x-icon";
    default:
      return "application/octet-stream";
  }
}

export function startCompanionUiServer(opts: {
  port: number;
  gatewayPort: number;
  gatewayToken: string;
}): Promise<HttpServer | null> {
  const root = resolveCompanionUiRoot();
  if (!root) return Promise.resolve(null);

  const { port, gatewayPort, gatewayToken } = opts;

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);
    let pathname = url.pathname;

    if (pathname === "/" && !url.searchParams.has("token") && gatewayToken) {
      const target = `/?token=${encodeURIComponent(gatewayToken)}&gatewayUrl=${encodeURIComponent(`ws://127.0.0.1:${gatewayPort}`)}`;
      res.statusCode = 302;
      res.setHeader("Location", target);
      res.end();
      return;
    }

    if (pathname === "/") pathname = "/index.html";

    const rel = pathname.slice(1);
    const normalized = path.posix.normalize(rel);
    if (normalized.startsWith("../") || normalized === ".." || normalized.includes("\0")) {
      res.statusCode = 403;
      res.end("Forbidden");
      return;
    }

    const filePath = path.join(root, normalized);
    if (!filePath.startsWith(root)) {
      res.statusCode = 403;
      res.end("Forbidden");
      return;
    }

    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext = path.extname(filePath).toLowerCase();
      res.setHeader("Content-Type", contentTypeForExt(ext));
      res.setHeader("Cache-Control", "no-cache");
      res.end(fs.readFileSync(filePath));
      return;
    }

    const indexPath = path.join(root, "index.html");
    if (fs.existsSync(indexPath)) {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache");
      res.end(fs.readFileSync(indexPath));
      return;
    }

    res.statusCode = 404;
    res.end("Not Found");
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve(server);
    });
  });
}

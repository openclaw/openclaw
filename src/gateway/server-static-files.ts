import fs from "node:fs";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

export type StaticFilesConfig = {
  /** Enable static file serving (default: false). */
  enabled?: boolean;
  /** Directory to serve files from (default: workspace). */
  root?: string;
  /** URL path prefix (default: /files). */
  basePath?: string;
  /** Allowed file extensions (default: common image/doc types). */
  allowedExtensions?: string[];
};

const DEFAULT_ALLOWED_EXTENSIONS = [
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".svg",
  ".ico",
  ".pdf",
  ".txt",
  ".md",
  ".json",
  ".csv",
  ".html",
  ".css",
  ".js",
];

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function getMimeType(ext: string): string {
  return MIME_TYPES[ext.toLowerCase()] ?? "application/octet-stream";
}

function isSafePath(requestedPath: string, root: string): string | null {
  // Normalize and resolve the full path
  const normalizedPath = path.normalize(requestedPath).replace(/^(\.\.[/\\])+/, "");
  const fullPath = path.resolve(root, normalizedPath);

  // Ensure the resolved path is within the root directory
  const resolvedRoot = path.resolve(root);
  if (!fullPath.startsWith(resolvedRoot + path.sep) && fullPath !== resolvedRoot) {
    return null;
  }

  return fullPath;
}

export function createStaticFilesHandler(config: StaticFilesConfig): (
  req: IncomingMessage,
  res: ServerResponse,
) => boolean {
  const enabled = config.enabled ?? false;
  const root = config.root ?? process.cwd();
  const basePath = (config.basePath ?? "/files").replace(/\/+$/, "");
  const allowedExtensions = new Set(
    (config.allowedExtensions ?? DEFAULT_ALLOWED_EXTENSIONS).map((ext) =>
      ext.startsWith(".") ? ext.toLowerCase() : `.${ext.toLowerCase()}`,
    ),
  );

  return (req: IncomingMessage, res: ServerResponse): boolean => {
    if (!enabled) {
      return false;
    }

    const method = (req.method ?? "GET").toUpperCase();
    if (method !== "GET" && method !== "HEAD") {
      return false;
    }

    const url = new URL(req.url ?? "/", "http://localhost");
    const pathname = url.pathname;

    // Check if this request is for our base path
    if (pathname !== basePath && !pathname.startsWith(`${basePath}/`)) {
      return false;
    }

    // Extract the file path from the URL
    const relativePath = pathname.slice(basePath.length).replace(/^\/+/, "");
    if (!relativePath) {
      res.statusCode = 404;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Not Found");
      return true;
    }

    // Check file extension
    const ext = path.extname(relativePath).toLowerCase();
    if (!allowedExtensions.has(ext)) {
      res.statusCode = 403;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Forbidden: File type not allowed");
      return true;
    }

    // Validate and resolve the path
    const filePath = isSafePath(relativePath, root);
    if (!filePath) {
      res.statusCode = 403;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Forbidden: Invalid path");
      return true;
    }

    // Check if file exists and is a regular file
    try {
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) {
        res.statusCode = 404;
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end("Not Found");
        return true;
      }

      // Serve the file
      res.statusCode = 200;
      res.setHeader("Content-Type", getMimeType(ext));
      res.setHeader("Content-Length", stat.size);
      res.setHeader("Cache-Control", "public, max-age=300"); // 5 min cache

      if (method === "HEAD") {
        res.end();
      } else {
        const stream = fs.createReadStream(filePath);
        stream.pipe(res);
        stream.on("error", () => {
          if (!res.headersSent) {
            res.statusCode = 500;
            res.end("Internal Server Error");
          }
        });
      }
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        res.statusCode = 404;
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end("Not Found");
      } else {
        res.statusCode = 500;
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end("Internal Server Error");
      }
      return true;
    }
  };
}

import type { IncomingMessage, ServerResponse } from "node:http";
import fs from "node:fs";
import path from "node:path";
import type { BotConfig } from "../config/config.js";
import { resolveControlUiRootSync } from "../infra/control-ui-assets.js";
import { DEFAULT_ASSISTANT_IDENTITY, resolveAssistantIdentity } from "./assistant-identity.js";
import {
  CONTROL_UI_BOOTSTRAP_CONFIG_PATH,
  type ControlUiBootstrapConfig,
  type ControlUiBootstrapIamConfig,
} from "./control-ui-contract.js";
import { buildControlUiCspHeader } from "./control-ui-csp.js";
import {
  buildControlUiAvatarUrl,
  CONTROL_UI_AVATAR_PREFIX,
  normalizeControlUiBasePath,
  resolveAssistantAvatarUrl,
} from "./control-ui-shared.js";

const ROOT_PREFIX = "/";

export type ControlUiRequestOptions = {
  basePath?: string;
  config?: BotConfig;
  agentId?: string;
  root?: ControlUiRootState;
  /** Pre-authenticated token from HTTP Bearer to forward to the SPA. */
  bearerToken?: string;
};

export type ControlUiRootState =
  | { kind: "resolved"; path: string }
  | { kind: "invalid"; path: string }
  | { kind: "missing" };

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
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".ico":
      return "image/x-icon";
    case ".txt":
      return "text/plain; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}

export type ControlUiAvatarResolution =
  | { kind: "none"; reason: string }
  | { kind: "local"; filePath: string }
  | { kind: "remote"; url: string }
  | { kind: "data"; url: string };

type ControlUiAvatarMeta = {
  avatarUrl: string | null;
};

function applyControlUiSecurityHeaders(res: ServerResponse, iamServerUrl?: string) {
  res.setHeader("Content-Security-Policy", buildControlUiCspHeader(iamServerUrl));
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.end(JSON.stringify(body));
}

function isValidAgentId(agentId: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(agentId);
}

export function handleControlUiAvatarRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: { basePath?: string; resolveAvatar: (agentId: string) => ControlUiAvatarResolution },
): boolean {
  const urlRaw = req.url;
  if (!urlRaw) {
    return false;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    return false;
  }

  const url = new URL(urlRaw, "http://localhost");
  const basePath = normalizeControlUiBasePath(opts.basePath);
  const pathname = url.pathname;
  const pathWithBase = basePath
    ? `${basePath}${CONTROL_UI_AVATAR_PREFIX}/`
    : `${CONTROL_UI_AVATAR_PREFIX}/`;
  if (!pathname.startsWith(pathWithBase)) {
    return false;
  }

  applyControlUiSecurityHeaders(res);

  const agentIdParts = pathname.slice(pathWithBase.length).split("/").filter(Boolean);
  const agentId = agentIdParts[0] ?? "";
  if (agentIdParts.length !== 1 || !agentId || !isValidAgentId(agentId)) {
    respondNotFound(res);
    return true;
  }

  if (url.searchParams.get("meta") === "1") {
    const resolved = opts.resolveAvatar(agentId);
    const avatarUrl =
      resolved.kind === "local"
        ? buildControlUiAvatarUrl(basePath, agentId)
        : resolved.kind === "remote" || resolved.kind === "data"
          ? resolved.url
          : null;
    sendJson(res, 200, { avatarUrl } satisfies ControlUiAvatarMeta);
    return true;
  }

  const resolved = opts.resolveAvatar(agentId);
  if (resolved.kind !== "local") {
    respondNotFound(res);
    return true;
  }

  // Reject avatar symlinks: the filePath must not be a symlink (prevents
  // path traversal via crafted avatar file references).
  try {
    const stat = fs.lstatSync(resolved.filePath);
    if (stat.isSymbolicLink()) {
      respondNotFound(res);
      return true;
    }
  } catch {
    respondNotFound(res);
    return true;
  }

  if (req.method === "HEAD") {
    res.statusCode = 200;
    res.setHeader("Content-Type", contentTypeForExt(path.extname(resolved.filePath).toLowerCase()));
    res.setHeader("Cache-Control", "no-cache");
    res.end();
    return true;
  }

  serveFile(res, resolved.filePath);
  return true;
}

function respondNotFound(res: ServerResponse) {
  res.statusCode = 404;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end("Not Found");
}

function serveFile(res: ServerResponse, filePath: string) {
  const ext = path.extname(filePath).toLowerCase();
  res.setHeader("Content-Type", contentTypeForExt(ext));
  // Static UI should never be cached aggressively while iterating; allow the
  // browser to revalidate.
  res.setHeader("Cache-Control", "no-cache");
  res.end(fs.readFileSync(filePath));
}

function serveIndexHtml(res: ServerResponse, indexPath: string) {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.end(fs.readFileSync(indexPath, "utf8"));
}

const STATIC_ASSET_EXTENSIONS = new Set([
  ".svg",
  ".js",
  ".mjs",
  ".css",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".json",
  ".map",
  ".txt",
  ".woff",
  ".woff2",
  ".ttf",
  ".eot",
  ".xml",
  ".webmanifest",
]);

function isStaticAssetExtension(ext: string): boolean {
  return STATIC_ASSET_EXTENSIONS.has(ext);
}

function isSafeRelativePath(relPath: string) {
  if (!relPath) {
    return false;
  }
  const normalized = path.posix.normalize(relPath);
  if (normalized.startsWith("../") || normalized === "..") {
    return false;
  }
  // Reject absolute paths (e.g. "/etc/passwd" embedded in URL after basePath)
  if (normalized.startsWith("/")) {
    return false;
  }
  if (normalized.includes("\0")) {
    return false;
  }
  return true;
}

/**
 * Verify that a resolved file path stays within the root directory after
 * symlink resolution. Returns false if the real path escapes root, or if
 * the file does not exist.
 */
function isFileWithinRoot(filePath: string, root: string): boolean {
  try {
    const realFilePath = fs.realpathSync(filePath);
    const realRoot = fs.realpathSync(root);
    // Allow exact match (root/index.html) or nested path (root/assets/foo)
    return realFilePath === realRoot || realFilePath.startsWith(`${realRoot}${path.sep}`);
  } catch {
    // File does not exist or cannot be resolved
    return false;
  }
}

export function handleControlUiHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts?: ControlUiRequestOptions,
): boolean {
  const urlRaw = req.url;
  if (!urlRaw) {
    return false;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.statusCode = 405;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Method Not Allowed");
    return true;
  }

  const url = new URL(urlRaw, "http://localhost");
  const basePath = normalizeControlUiBasePath(opts?.basePath);
  const pathname = url.pathname;

  if (!basePath) {
    if (pathname === "/ui" || pathname.startsWith("/ui/")) {
      applyControlUiSecurityHeaders(res);
      respondNotFound(res);
      return true;
    }
  }

  if (basePath) {
    if (pathname === basePath) {
      applyControlUiSecurityHeaders(res);
      res.statusCode = 302;
      res.setHeader("Location", `${basePath}/${url.search}`);
      res.end();
      return true;
    }
    if (!pathname.startsWith(`${basePath}/`)) {
      return false;
    }
  }

  const iamServerUrl = opts?.config?.gateway?.auth?.iam?.serverUrl;
  applyControlUiSecurityHeaders(res, iamServerUrl);

  const bootstrapConfigPath = basePath
    ? `${basePath}${CONTROL_UI_BOOTSTRAP_CONFIG_PATH}`
    : CONTROL_UI_BOOTSTRAP_CONFIG_PATH;
  if (pathname === bootstrapConfigPath) {
    const config = opts?.config;
    const identity = config
      ? resolveAssistantIdentity({ cfg: config, agentId: opts?.agentId })
      : DEFAULT_ASSISTANT_IDENTITY;
    const avatarValue = resolveAssistantAvatarUrl({
      avatar: identity.avatar,
      agentId: identity.agentId,
      basePath,
    });
    if (req.method === "HEAD") {
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache");
      res.end();
      return true;
    }
    const authMode = config?.gateway?.auth?.mode ?? "none";
    const iamCfg = config?.gateway?.auth?.iam;
    const iamBootstrap: ControlUiBootstrapIamConfig | undefined =
      authMode === "iam" && iamCfg
        ? {
            serverUrl: iamCfg.serverUrl,
            clientId: iamCfg.clientId,
            appName: iamCfg.appName,
            orgName: iamCfg.orgName,
            scopes: iamCfg.scopes,
          }
        : undefined;

    const marketplaceEnabled = config?.gateway?.marketplace?.enabled === true;
    sendJson(res, 200, {
      basePath,
      assistantName: identity.name,
      assistantAvatar: avatarValue ?? identity.avatar,
      assistantAgentId: identity.agentId,
      authMode,
      iam: iamBootstrap,
      token: opts?.bearerToken,
      marketplaceEnabled,
    } satisfies ControlUiBootstrapConfig);
    return true;
  }

  const rootState = opts?.root;
  if (rootState?.kind === "invalid") {
    res.statusCode = 503;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end(
      `Control UI assets not found at ${rootState.path}. Build them with \`pnpm ui:build\` (auto-installs UI deps), or update gateway.controlUi.root.`,
    );
    return true;
  }
  if (rootState?.kind === "missing") {
    res.statusCode = 503;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end(
      "Control UI assets not found. Build them with `pnpm ui:build` (auto-installs UI deps), or run `pnpm ui:dev` during development.",
    );
    return true;
  }

  const root =
    rootState?.kind === "resolved"
      ? rootState.path
      : resolveControlUiRootSync({
          moduleUrl: import.meta.url,
          argv1: process.argv[1],
          cwd: process.cwd(),
        });
  if (!root) {
    res.statusCode = 503;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end(
      "Control UI assets not found. Build them with `pnpm ui:build` (auto-installs UI deps), or run `pnpm ui:dev` during development.",
    );
    return true;
  }

  const uiPath =
    basePath && pathname.startsWith(`${basePath}/`) ? pathname.slice(basePath.length) : pathname;
  const rel = (() => {
    if (uiPath === ROOT_PREFIX) {
      return "";
    }
    const assetsIndex = uiPath.indexOf("/assets/");
    if (assetsIndex >= 0) {
      return uiPath.slice(assetsIndex + 1);
    }
    return uiPath.slice(1);
  })();
  const requested = rel && !rel.endsWith("/") ? rel : `${rel}index.html`;
  const fileRel = requested || "index.html";
  if (!isSafeRelativePath(fileRel)) {
    respondNotFound(res);
    return true;
  }

  const filePath = path.join(root, fileRel);
  if (!filePath.startsWith(root)) {
    respondNotFound(res);
    return true;
  }

  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    // Reject symlinks that escape the control-ui root directory
    if (!isFileWithinRoot(filePath, root)) {
      respondNotFound(res);
      return true;
    }
    if (path.basename(filePath) === "index.html") {
      serveIndexHtml(res, filePath);
      return true;
    }
    if (req.method === "HEAD") {
      res.statusCode = 200;
      res.setHeader("Content-Type", contentTypeForExt(path.extname(filePath).toLowerCase()));
      res.setHeader("Cache-Control", "no-cache");
      res.end();
      return true;
    }
    serveFile(res, filePath);
    return true;
  }

  // Return 404 for missing static assets (known file extensions) instead of
  // serving the SPA fallback.  This prevents browsers from loading index.html
  // in place of e.g. a missing favicon.svg and triggering parse errors.
  const requestedExt = path.extname(fileRel).toLowerCase();
  if (requestedExt && isStaticAssetExtension(requestedExt)) {
    respondNotFound(res);
    return true;
  }

  // SPA fallback (client-side router): serve index.html for unknown paths.
  const indexPath = path.join(root, "index.html");
  if (fs.existsSync(indexPath)) {
    // Reject index.html symlinks that escape the control-ui root directory
    if (!isFileWithinRoot(indexPath, root)) {
      respondNotFound(res);
      return true;
    }
    serveIndexHtml(res, indexPath);
    return true;
  }

  respondNotFound(res);
  return true;
}

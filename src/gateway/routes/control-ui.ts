/**
 * Control UI SPA + Avatar routes — Elysia plugin.
 *
 * Two concerns:
 *   1. Avatar serving:  GET {basePath}/avatar/{agentId}  (+ ?meta=1 for JSON metadata)
 *   2. SPA serving:     GET {basePath}/*  with static file serving and index.html SPA fallback
 *
 * Translates the raw-Node `handleControlUiHttpRequest` / `handleControlUiAvatarRequest`
 * logic into Web-Standard Response objects returned from Elysia handlers.
 */

import { Elysia } from "elysia";
import fs from "node:fs";
import path from "node:path";
import type { ControlUiRootState } from "../control-ui-shared.js";
import { resolveAgentAvatar } from "../../agents/identity-avatar.js";
import { loadConfig } from "../../config/config.js";
import { resolveControlUiRootSync } from "../../infra/control-ui-assets.js";
import { DEFAULT_ASSISTANT_IDENTITY, resolveAssistantIdentity } from "../assistant-identity.js";
import { isLocalDirectRequest } from "../auth.js";
import {
  buildControlUiAvatarUrl,
  CONTROL_UI_AVATAR_PREFIX,
  normalizeControlUiBasePath,
  resolveAssistantAvatarUrl,
} from "../control-ui-shared.js";
import { getNodeRequest } from "../elysia-node-compat.js";

// ============================================================================
// Helpers
// ============================================================================

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
    case ".woff":
      return "font/woff";
    case ".woff2":
      return "font/woff2";
    case ".ttf":
      return "font/ttf";
    default:
      return "application/octet-stream";
  }
}

function isValidAgentId(agentId: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(agentId);
}

function isSafeRelativePath(relPath: string): boolean {
  if (!relPath) {
    return false;
  }
  const normalized = path.posix.normalize(relPath);
  if (normalized.startsWith("../") || normalized === "..") {
    return false;
  }
  if (normalized.includes("\0")) {
    return false;
  }
  return true;
}

/** Inject runtime config into the SPA index.html before </head>. */
function injectControlUiConfig(
  html: string,
  opts: { basePath: string; assistantName?: string; assistantAvatar?: string },
): string {
  const { basePath, assistantName, assistantAvatar } = opts;
  const script =
    `<script>` +
    `window.__OPENCLAW_CONTROL_UI_BASE_PATH__=${JSON.stringify(basePath)};` +
    `window.__OPENCLAW_ASSISTANT_NAME__=${JSON.stringify(
      assistantName ?? DEFAULT_ASSISTANT_IDENTITY.name,
    )};` +
    `window.__OPENCLAW_ASSISTANT_AVATAR__=${JSON.stringify(
      assistantAvatar ?? DEFAULT_ASSISTANT_IDENTITY.avatar,
    )};` +
    `</script>`;
  // Avoid double-injection
  if (html.includes("__OPENCLAW_ASSISTANT_NAME__")) {
    return html;
  }
  const headClose = html.indexOf("</head>");
  if (headClose !== -1) {
    return `${html.slice(0, headClose)}${script}${html.slice(headClose)}`;
  }
  return `${script}${html}`;
}

const NO_CACHE = "no-cache";
const ROOT_PREFIX = "/";

// ============================================================================
// Plugin
// ============================================================================

export function controlUiRoutes(params: { basePath: string; root?: ControlUiRootState }) {
  const basePath = normalizeControlUiBasePath(params.basePath);
  const rootState = params.root;

  return new Elysia({ name: "control-ui-routes" }).all("/*", async ({ request }) => {
    const url = new URL(request.url);
    const pathname = url.pathname;

    // Only handle GET / HEAD
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method Not Allowed", {
        status: 405,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }

    // ----------------------------------------------------------------
    // Avatar route: {basePath}/avatar/{agentId}
    // ----------------------------------------------------------------
    const avatarHandled = handleAvatarRoute(request, url, pathname, basePath);
    if (avatarHandled) {
      return avatarHandled;
    }

    // ----------------------------------------------------------------
    // Token redirect for localhost (auto-append ?token= for convenience)
    // ----------------------------------------------------------------
    const tokenRedirect = maybeRedirectToTokenizedUi(request, url, pathname, basePath);
    if (tokenRedirect) {
      return tokenRedirect;
    }

    // ----------------------------------------------------------------
    // Base path guard: if basePath is set, reject paths that don't match
    // ----------------------------------------------------------------
    if (!basePath) {
      // When basePath is empty, reject /ui or /ui/* to avoid ambiguity
      if (pathname === "/ui" || pathname.startsWith("/ui/")) {
        return notFoundResponse();
      }
    }

    if (basePath) {
      // Redirect /basePath -> /basePath/
      if (pathname === basePath) {
        return new Response(null, {
          status: 302,
          headers: { Location: `${basePath}/${url.search}` },
        });
      }
      if (!pathname.startsWith(`${basePath}/`)) {
        return; // Not our route — pass through to Elysia
      }
    }

    // ----------------------------------------------------------------
    // Root state checks (missing/invalid assets)
    // ----------------------------------------------------------------
    if (rootState?.kind === "invalid") {
      return new Response(
        `Control UI assets not found at ${rootState.path}. Build them with \`pnpm ui:build\` (auto-installs UI deps), or update gateway.controlUi.root.`,
        { status: 503, headers: { "content-type": "text/plain; charset=utf-8" } },
      );
    }
    if (rootState?.kind === "missing") {
      return new Response(
        "Control UI assets not found. Build them with `pnpm ui:build` (auto-installs UI deps), or run `pnpm ui:dev` during development.",
        { status: 503, headers: { "content-type": "text/plain; charset=utf-8" } },
      );
    }

    // Resolve the asset root directory
    const root =
      rootState?.kind === "resolved"
        ? rootState.path
        : resolveControlUiRootSync({
            moduleUrl: import.meta.url,
            argv1: process.argv[1],
            cwd: process.cwd(),
          });
    if (!root) {
      return new Response(
        "Control UI assets not found. Build them with `pnpm ui:build` (auto-installs UI deps), or run `pnpm ui:dev` during development.",
        { status: 503, headers: { "content-type": "text/plain; charset=utf-8" } },
      );
    }

    // ----------------------------------------------------------------
    // Static file serving + SPA fallback
    // ----------------------------------------------------------------
    return serveSpaRequest(request, pathname, url, basePath, root);
  });
}

// ============================================================================
// Avatar Handler
// ============================================================================

function handleAvatarRoute(
  request: Request,
  url: URL,
  pathname: string,
  basePath: string,
): Response | null {
  const pathWithBase = basePath
    ? `${basePath}${CONTROL_UI_AVATAR_PREFIX}/`
    : `${CONTROL_UI_AVATAR_PREFIX}/`;

  if (!pathname.startsWith(pathWithBase)) {
    return null;
  }

  const agentIdParts = pathname.slice(pathWithBase.length).split("/").filter(Boolean);
  const agentId = agentIdParts[0] ?? "";
  if (agentIdParts.length !== 1 || !agentId || !isValidAgentId(agentId)) {
    return notFoundResponse();
  }

  let cfg;
  try {
    cfg = loadConfig();
  } catch {
    return notFoundResponse();
  }

  const resolved = resolveAgentAvatar(cfg, agentId);

  // ?meta=1 returns JSON metadata about the avatar
  if (url.searchParams.get("meta") === "1") {
    const avatarUrl =
      resolved.kind === "local"
        ? buildControlUiAvatarUrl(basePath, agentId)
        : resolved.kind === "remote" || resolved.kind === "data"
          ? resolved.url
          : null;
    return new Response(JSON.stringify({ avatarUrl }), {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": NO_CACHE,
      },
    });
  }

  // Serve the avatar file directly (local only)
  if (resolved.kind !== "local") {
    return notFoundResponse();
  }

  if (request.method === "HEAD") {
    return new Response(null, {
      status: 200,
      headers: {
        "content-type": contentTypeForExt(path.extname(resolved.filePath).toLowerCase()),
        "cache-control": NO_CACHE,
      },
    });
  }

  return serveStaticFile(resolved.filePath);
}

// ============================================================================
// Token Redirect (localhost convenience)
// ============================================================================

function maybeRedirectToTokenizedUi(
  request: Request,
  url: URL,
  pathname: string,
  basePath: string,
): Response | null {
  let cfg;
  try {
    cfg = loadConfig();
  } catch {
    return null;
  }

  const token = cfg.gateway?.auth?.token?.trim();
  if (!token) {
    return null;
  }
  // Already has a token query param
  if (url.searchParams.get("token")?.trim()) {
    return null;
  }

  const trustedProxies = cfg.gateway?.trustedProxies ?? [];
  const nodeReq = getNodeRequest(request);
  if (!isLocalDirectRequest(nodeReq, trustedProxies)) {
    return null;
  }

  // Only rewrite Control UI navigations, not static assets or avatar endpoints
  if (basePath) {
    if (pathname !== basePath && !pathname.startsWith(`${basePath}/`)) {
      return null;
    }
  }
  if (pathname.includes("/assets/")) {
    return null;
  }
  if (pathname.startsWith(`${basePath}${CONTROL_UI_AVATAR_PREFIX}/`)) {
    return null;
  }
  if (!basePath && pathname.startsWith(`${CONTROL_UI_AVATAR_PREFIX}/`)) {
    return null;
  }
  if (path.extname(pathname)) {
    return null;
  }

  const redirected = new URL(url.toString());
  redirected.searchParams.set("token", token);
  if (basePath && redirected.pathname === basePath) {
    redirected.pathname = `${basePath}/`;
  }

  return new Response(null, {
    status: 302,
    headers: { Location: `${redirected.pathname}${redirected.search}` },
  });
}

// ============================================================================
// SPA Serving
// ============================================================================

function serveSpaRequest(
  request: Request,
  pathname: string,
  url: URL,
  basePath: string,
  root: string,
): Response {
  // Strip basePath prefix from the URL path to get the SPA-relative path
  const uiPath =
    basePath && pathname.startsWith(`${basePath}/`) ? pathname.slice(basePath.length) : pathname;

  // Resolve the relative file path within the asset root
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

  // Directory traversal guard
  if (!isSafeRelativePath(fileRel)) {
    return notFoundResponse();
  }

  const filePath = path.join(root, fileRel);
  if (!filePath.startsWith(root)) {
    return notFoundResponse();
  }

  // Serve exact file if it exists
  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    if (path.basename(filePath) === "index.html") {
      return serveIndexHtml(request, filePath, basePath);
    }
    if (request.method === "HEAD") {
      return new Response(null, {
        status: 200,
        headers: {
          "content-type": contentTypeForExt(path.extname(filePath).toLowerCase()),
          "cache-control": NO_CACHE,
        },
      });
    }
    return serveStaticFile(filePath);
  }

  // Astro static site: each route generates a `route/index.html` directory.
  if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
    const dirIndex = path.join(filePath, "index.html");
    if (fs.existsSync(dirIndex)) {
      return serveIndexHtml(request, dirIndex, basePath);
    }
  }

  // SPA fallback: serve index.html for unknown paths (client-side router)
  const indexPath = path.join(root, "index.html");
  if (fs.existsSync(indexPath)) {
    return serveIndexHtml(request, indexPath, basePath);
  }

  return notFoundResponse();
}

// ============================================================================
// File Serving Helpers
// ============================================================================

function serveStaticFile(filePath: string): Response {
  const ext = path.extname(filePath).toLowerCase();
  const buffer = fs.readFileSync(filePath);
  return new Response(buffer, {
    status: 200,
    headers: {
      "content-type": contentTypeForExt(ext),
      "cache-control": NO_CACHE,
    },
  });
}

function serveIndexHtml(request: Request, indexPath: string, basePath: string): Response {
  let cfg;
  try {
    cfg = loadConfig();
  } catch {
    cfg = undefined;
  }

  const identity = cfg ? resolveAssistantIdentity({ cfg }) : DEFAULT_ASSISTANT_IDENTITY;

  const resolvedAgentId =
    typeof (identity as { agentId?: string }).agentId === "string"
      ? (identity as { agentId?: string }).agentId
      : undefined;

  const avatarValue =
    resolveAssistantAvatarUrl({
      avatar: identity.avatar,
      agentId: resolvedAgentId,
      basePath,
    }) ?? identity.avatar;

  const raw = fs.readFileSync(indexPath, "utf8");
  const html = injectControlUiConfig(raw, {
    basePath,
    assistantName: identity.name,
    assistantAvatar: avatarValue,
  });

  if (request.method === "HEAD") {
    return new Response(null, {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": NO_CACHE,
      },
    });
  }

  return new Response(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": NO_CACHE,
    },
  });
}

function notFoundResponse(): Response {
  return new Response("Not Found", {
    status: 404,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

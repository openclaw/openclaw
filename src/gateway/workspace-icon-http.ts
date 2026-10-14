// Serves a workspace directory's own project icon so the Control UI can render
// real project identity instead of a generic folder glyph.
import { close } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { promisify } from "node:util";
import {
  getAgentWorkspaceAccess,
  isWorkspaceAccessUnavailableError,
} from "../agents/workspace-access.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { openRootFile, readFileDescriptorBounded } from "../infra/boundary-file-read.js";
import { LruCache } from "../infra/lru-cache.js";
import { parseControlUiResourcePath } from "./control-ui-contract.js";
import { respondNotFound } from "./control-ui-http-utils.js";
import { sendMethodNotAllowed } from "./http-common.js";
import {
  HTTP_IMAGE_MAX_BYTES,
  HTTP_SVG_MAX_BYTES,
  resolveHttpImageRepresentation,
  sendHttpImageResponse,
  type HttpImageRepresentation,
} from "./http-image-response.js";
import type { GatewayHttpRequestAuthOptions } from "./http-request-authority.js";
import { authorizeControlUiSessionOwnerReadRequestOrReply } from "./http-utils.js";
import { withReadySessionRows, type SessionRowReadView } from "./session-row-prepared-read.js";
import { getSessionRowProjection } from "./session-row-projection-access.js";
import { resolveSessionStoreIdentity } from "./session-store-key.js";
import { resolveSessionWorkspaceRoots } from "./session-workspace-roots.js";

/**
 * Conventional project icon locations in deterministic product precedence.
 * Resolution stops at the first valid hit, so this fixed list is the whole
 * filesystem cost of opening a workspace and never becomes a recursive scan.
 */
const WORKSPACE_ICON_RELATIVE_PATHS = [
  "favicon.svg",
  "favicon.ico",
  "favicon.png",
  "public/favicon.svg",
  "public/favicon.ico",
  "public/favicon.png",
  "public/favicon-32.png",
  "public/apple-touch-icon.png",
  "static/favicon.svg",
  "static/favicon.ico",
  "static/favicon.png",
  "ui/public/favicon-32.png",
  "ui/public/favicon.svg",
  "ui/public/favicon.ico",
  "ui/public/favicon.png",
  "app/favicon.ico",
  "app/favicon.png",
  "app/icon.svg",
  "app/icon.png",
  "app/icon.ico",
  "src/favicon.ico",
  "src/favicon.svg",
  "src/app/favicon.ico",
  "src/app/icon.svg",
  "src/app/icon.png",
  "assets/icon.svg",
  "assets/icon.png",
  "assets/logo.svg",
  "assets/logo.png",
] as const;

/** Icons are small by construction; anything larger is not a favicon. */
export const WORKSPACE_ICON_MAX_BYTES = HTTP_IMAGE_MAX_BYTES;
/** Vector icons are markup the renderer must parse, so they get a tighter cap. */
export const SVG_ICON_MAX_BYTES = HTTP_SVG_MAX_BYTES;
const WORKSPACE_ICON_CACHE_MAX_ENTRIES = 32;
const closeFileDescriptor = promisify(close);
type WorkspaceIcon = HttpImageRepresentation;

/** `null` records a resolved absence so a workspace without an icon never re-scans. */
type WorkspaceIconResolution = WorkspaceIcon | null;

let workspaceIconCache = new LruCache<Promise<WorkspaceIconResolution>>(
  WORKSPACE_ICON_CACHE_MAX_ENTRIES,
);

export function clearWorkspaceIconCacheForTest(): void {
  workspaceIconCache = new LruCache(WORKSPACE_ICON_CACHE_MAX_ENTRIES);
}

async function scanWorkspaceIcon(workspaceRoot: string): Promise<WorkspaceIconResolution> {
  for (const relativePath of WORKSPACE_ICON_RELATIVE_PATHS) {
    const opened = await openRootFile({
      absolutePath: path.join(workspaceRoot, relativePath),
      rootPath: workspaceRoot,
      boundaryLabel: "workspace root",
      symlinks: "follow-parents-within-root",
      maxBytes: WORKSPACE_ICON_MAX_BYTES,
    });
    if (!opened.ok) {
      continue;
    }
    let body: Buffer;
    try {
      body = await readFileDescriptorBounded(opened.fd, WORKSPACE_ICON_MAX_BYTES);
    } catch {
      continue;
    } finally {
      await closeFileDescriptor(opened.fd);
    }
    const icon = await resolveHttpImageRepresentation(relativePath, body);
    if (icon) {
      return icon;
    }
  }
  return null;
}

/**
 * Reuses immutable icon bytes while the workspace remains in the bounded cache.
 * Only cold/evicted roots scan the fixed candidate list; ordinary requests never
 * freshness-poll project files.
 */
export function resolveWorkspaceIcon(workspaceRoot: string): Promise<WorkspaceIconResolution> {
  const cacheKey = path.resolve(workspaceRoot);
  const cached = workspaceIconCache.get(cacheKey);
  if (cached) {
    return cached;
  }
  const pending = scanWorkspaceIcon(cacheKey);
  workspaceIconCache.set(cacheKey, pending);
  return pending;
}

function respondWorkspaceIconUnavailable(res: ServerResponse) {
  res.statusCode = 503;
  res.setHeader("cache-control", "no-store");
  res.setHeader("retry-after", "1");
  res.end("workspace icon snapshot is not ready");
}

/**
 * Resolve cold and evicted icons through the existing prepared session-row owner.
 * Store reads stay in its worker; bounded filesystem reads are asynchronous and
 * the current session/root and request authority fence publication of the bytes.
 */
export async function handleWorkspaceIconHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: GatewayHttpRequestAuthOptions & {
    basePath?: string;
    sessionRowProjectionOwner?: object;
  },
): Promise<boolean> {
  const pathname = req.url ? new URL(req.url, "http://localhost").pathname : undefined;
  const parsed = parseControlUiResourcePath("workspaceIcon", pathname, opts.basePath);
  if (!parsed.matched) {
    return false;
  }
  const method = req.method;
  if (method !== "GET" && method !== "HEAD") {
    sendMethodNotAllowed(res, "GET, HEAD");
    return true;
  }
  const requestAuth = await authorizeControlUiSessionOwnerReadRequestOrReply({
    ...opts,
    req,
    res,
  });
  if (!requestAuth) {
    return true;
  }
  requestAuth.assertCurrent();

  if (!parsed.value) {
    res.setHeader("cache-control", "no-store");
    respondNotFound(res);
    return true;
  }
  const projection = getSessionRowProjection(opts);
  if (!projection) {
    respondWorkspaceIconUnavailable(res);
    return true;
  }
  const sessionKey = parsed.value;
  const queries = (cfg: OpenClawConfig) => {
    const { agentId, canonicalKey } = resolveSessionStoreIdentity({ cfg, sessionKey });
    return [{ agentId, key: canonicalKey }] as const;
  };
  const select = (read: SessionRowReadView) => {
    const query = queries(read.state.cfg)[0];
    const row = read.describe(query);
    const entry = row?.storedEntry ?? row?.entry;
    const root =
      row && entry?.sessionId && !entry.execNode && !entry.repositoryWorkspaceId
        ? resolveSessionWorkspaceRoots(read.state.cfg, row.agentId, entry).root
        : undefined;
    let localRoot = root;
    if (localRoot) {
      try {
        if (getAgentWorkspaceAccess(localRoot)) {
          localRoot = undefined;
        }
      } catch (error) {
        if (!isWorkspaceAccessUnavailableError(error)) {
          throw error;
        }
        // A stopped remote owner must never expose a coincident local path.
        localRoot = undefined;
      }
    }
    return { generation: row?.generation, sessionId: entry?.sessionId, root: localRoot };
  };
  const selected = await withReadySessionRows(projection, queries, select);
  requestAuth.assertCurrent();
  const icon = selected.root ? await resolveWorkspaceIcon(selected.root) : null;
  await withReadySessionRows(projection, queries, (read) => {
    requestAuth.assertCurrent();
    const current = select(read);
    if (
      current.generation !== selected.generation ||
      current.sessionId !== selected.sessionId ||
      current.root !== selected.root
    ) {
      respondWorkspaceIconUnavailable(res);
    } else if (!icon) {
      res.setHeader("cache-control", selected.root ? "private, max-age=60" : "no-store");
      res.setHeader("vary", "Authorization, Cookie");
      respondNotFound(res);
    } else {
      sendHttpImageResponse({ req, res, image: icon, filename: "workspace-icon" });
    }
  });
  return true;
}

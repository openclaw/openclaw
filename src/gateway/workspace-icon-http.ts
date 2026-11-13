// Serves a workspace directory's own project icon so the Control UI can render
// real project identity instead of a generic folder glyph.
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import {
  getAgentWorkspaceAccess,
  isWorkspaceAccessUnavailableError,
} from "../agents/workspace-access.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { LruCache } from "../infra/lru-cache.js";
import { resolveRuntimeProcessEntrypointUrl } from "../infra/runtime-process-url.js";
import { WorkerTaskError, WorkerTaskPool } from "../infra/worker-task-pool.js";
import { runInDetachedAsyncContext } from "../shared/detached-async-context.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { parseControlUiResourcePath } from "./control-ui-contract.js";
import { respondNotFound } from "./control-ui-http-utils.js";
import { sendMethodNotAllowed, sendSessionReadForbidden } from "./http-common.js";
import { sendHttpImageResponse, type HttpImageRepresentation } from "./http-image-response.js";
import type { GatewayHttpRequestAuthOptions } from "./http-request-authority.js";
import { authorizeControlUiSessionOwnerReadRequestOrReply } from "./http-utils.js";
import { withReadySessionRows, type SessionRowReadView } from "./session-row-prepared-read.js";
import { getSessionRowProjection } from "./session-row-projection-access.js";
import { resolveSessionStoreIdentity } from "./session-store-key.js";
import { resolveSessionWorkspaceRoots } from "./session-workspace-roots.js";
import type { WorkspaceIconSnapshot } from "./workspace-icon-scan.js";
export { SVG_ICON_MAX_BYTES, WORKSPACE_ICON_MAX_BYTES } from "./workspace-icon-scan.js";

type WorkspaceIconResolution = HttpImageRepresentation | null;
type WorkspaceIconRuntime = {
  cache: LruCache<Promise<WorkspaceIconResolution>>;
  pool?: WorkerTaskPool<string, WorkspaceIconSnapshot | null>;
  closing?: Promise<void>;
};

/** Cold roots share bounded worker work; HTTP callers retain only publication authority. */
export function resolveWorkspaceIcon(workspaceRoot: string): Promise<WorkspaceIconResolution> {
  const runtime = resolveGlobalSingleton<WorkspaceIconRuntime>(
    Symbol.for("openclaw.workspaceIcons"),
    () => ({ cache: new LruCache(32) }),
    (state) => {
      state.closing ??= (async () => {
        await state.pool?.close();
        state.pool = undefined;
        state.cache.clear();
      })().finally(() => {
        state.closing = undefined;
      });
      return state.closing;
    },
  );
  if (runtime.closing) {
    return Promise.reject(new WorkerTaskError("Workspace icon reader is closing", "unavailable"));
  }
  const cacheKey = path.resolve(workspaceRoot);
  const cached = runtime.cache.get(cacheKey);
  if (cached) {
    return cached;
  }
  // A disconnected first requester must not retire another requester's shared scan.
  const pending = runInDetachedAsyncContext(async () => {
    const pool = (runtime.pool ??= new WorkerTaskPool<string, WorkspaceIconSnapshot | null>({
      workerUrl: resolveRuntimeProcessEntrypointUrl("workspaceIcon"),
      workerClass: "file-reader",
      idleTimeoutMs: 10 * 60_000,
      maxPendingTasks: 32,
      maxPendingBytes: 256 * 1024,
    }));
    const icon = await pool.run(cacheKey, { inputBytes: 2 * cacheKey.length });
    return (
      icon && {
        ...icon,
        body: Buffer.from(icon.body.buffer, icon.body.byteOffset, icon.body.byteLength),
      }
    );
  }).catch((error: unknown) => {
    // Admission and worker failures are retryable, never a cached absence.
    runtime.cache.deleteValue(pending);
    throw error;
  });
  runtime.cache.set(cacheKey, pending);
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
 * Store reads and icon filesystem traversal stay in workers;
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
    // An unknown session stays an ordinary miss; a known one must be visible to the profile.
    const visible = entry ? requestAuth.canReadSession(query.key, entry) : true;
    return {
      generation: row?.generation,
      sessionId: entry?.sessionId,
      root: visible ? localRoot : undefined,
      visible,
    };
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
      current.root !== selected.root ||
      current.visible !== selected.visible
    ) {
      respondWorkspaceIconUnavailable(res);
    } else if (!selected.visible) {
      sendSessionReadForbidden(res);
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

// Read-only agent workspace browser: bounded directory listing and size-capped,
// type-gated file reads confined to the agent workspace root (#100705).
// Strictly read scope; write/delete/upload stay with the broader workspace API.
import path from "node:path";
import { kindFromMime, mimeTypeFromFilePath } from "@openclaw/media-core/mime";
import {
  ErrorCodes,
  errorShape,
  type AgentsWorkspaceEntry,
  validateAgentsWorkspaceListParams,
  validateAgentsWorkspaceReadParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { listAgentIds, resolveAgentWorkspaceDir } from "../../agents/agent-scope.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { root as fsSafeRoot, FsSafeError } from "../../infra/fs-safe.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import type { GatewayRequestHandlers, RespondFn } from "./types.js";
import { assertValidParams } from "./validation.js";

const MAX_LIST_ENTRIES = 250;
const MAX_TEXT_READ_BYTES = 256 * 1024;
const MAX_IMAGE_READ_BYTES = 5 * 1024 * 1024;

type WorkspaceRoot = Awaited<ReturnType<typeof fsSafeRoot>>;

function workspaceError(type: string, message: string, details?: Record<string, unknown>) {
  return errorShape(ErrorCodes.INVALID_REQUEST, message, { details: { type, ...details } });
}

function respondWorkspaceError(
  respond: RespondFn,
  type: string,
  message: string,
  details?: Record<string, unknown>,
) {
  respond(false, undefined, workspaceError(type, message, details));
}

/**
 * Normalizes a client path to a root-relative POSIX path. Returns undefined for
 * absolute paths and any `..` segment so traversal never reaches the filesystem;
 * fs-safe root containment stays as the second layer.
 */
function normalizeInRootPath(value: string | undefined): string | undefined {
  const raw = (value ?? "").trim();
  if (path.isAbsolute(raw) || raw.startsWith("\\") || /^[a-zA-Z]:/.test(raw)) {
    return undefined;
  }
  const parts = raw
    .replaceAll("\\", "/")
    .split("/")
    .filter((part) => part && part !== ".");
  if (parts.includes("..")) {
    return undefined;
  }
  return parts.join("/");
}

async function openWorkspaceRoot(workspaceDir: string): Promise<WorkspaceRoot | undefined> {
  try {
    return await fsSafeRoot(workspaceDir, {
      hardlinks: "reject",
      nonBlockingRead: true,
      symlinks: "reject",
    });
  } catch {
    return undefined;
  }
}

function resolveAgentOrRespond(
  params: { agentId: string },
  respond: RespondFn,
  cfg: OpenClawConfig,
): { agentId: string; workspaceDir: string } | null {
  const agentId = normalizeAgentId(params.agentId);
  if (!new Set(listAgentIds(cfg)).has(agentId)) {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unknown agent id"));
    return null;
  }
  return { agentId, workspaceDir: resolveAgentWorkspaceDir(cfg, agentId) };
}

function sortWorkspaceEntries(entries: readonly AgentsWorkspaceEntry[]): AgentsWorkspaceEntry[] {
  return entries.toSorted((a, b) => {
    if (a.kind !== b.kind) {
      return a.kind === "directory" ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });
}

/** Gateway handlers for the read-only agent workspace file browser. */
export const agentsWorkspaceHandlers: GatewayRequestHandlers = {
  "agents.workspace.list": async ({ params, respond, context }) => {
    if (
      !assertValidParams(
        params,
        validateAgentsWorkspaceListParams,
        "agents.workspace.list",
        respond,
      )
    ) {
      return;
    }
    const resolved = resolveAgentOrRespond(params, respond, context.getRuntimeConfig());
    if (!resolved) {
      return;
    }
    const relPath = normalizeInRootPath(params.path);
    if (relPath === undefined) {
      respondWorkspaceError(respond, "workspace_path_invalid", "path escapes workspace root", {
        path: params.path,
      });
      return;
    }
    const workspaceRoot = await openWorkspaceRoot(resolved.workspaceDir);
    if (!workspaceRoot) {
      respondWorkspaceError(respond, "workspace_unavailable", "agent workspace is unavailable");
      return;
    }
    let dirents: Awaited<ReturnType<WorkspaceRoot["list"]>>;
    try {
      const stat = await workspaceRoot.stat(relPath || ".");
      if (!stat.isDirectory) {
        respondWorkspaceError(respond, "workspace_not_a_directory", "path is not a directory", {
          path: relPath,
        });
        return;
      }
      dirents = await workspaceRoot.list(relPath || ".", { withFileTypes: true });
    } catch (err) {
      if (err instanceof FsSafeError) {
        respondWorkspaceError(respond, "workspace_path_not_found", "workspace path not found", {
          path: relPath,
        });
        return;
      }
      throw err;
    }
    const entries = sortWorkspaceEntries(
      dirents.flatMap((dirent): AgentsWorkspaceEntry[] => {
        // Symlinks and special files are intentionally invisible to the browser.
        const kind = dirent.isDirectory ? "directory" : dirent.isFile ? "file" : null;
        if (!kind || dirent.isSymbolicLink) {
          return [];
        }
        return [
          {
            path: relPath ? `${relPath}/${dirent.name}` : dirent.name,
            name: dirent.name,
            kind,
            ...(kind === "file" ? { size: dirent.size } : {}),
            updatedAtMs: Math.floor(dirent.mtimeMs),
          },
        ];
      }),
    );
    const offset = params.offset ?? 0;
    const page = entries.slice(offset, offset + MAX_LIST_ENTRIES);
    const parent = path.posix.dirname(relPath);
    respond(true, {
      agentId: resolved.agentId,
      workspace: resolved.workspaceDir,
      path: relPath,
      ...(relPath ? { parentPath: parent === "." ? "" : parent } : {}),
      entries: page,
      ...(offset + page.length < entries.length ? { truncated: true } : {}),
    });
  },
  "agents.workspace.read": async ({ params, respond, context }) => {
    if (
      !assertValidParams(
        params,
        validateAgentsWorkspaceReadParams,
        "agents.workspace.read",
        respond,
      )
    ) {
      return;
    }
    const resolved = resolveAgentOrRespond(params, respond, context.getRuntimeConfig());
    if (!resolved) {
      return;
    }
    const relPath = normalizeInRootPath(params.path);
    if (!relPath) {
      respondWorkspaceError(respond, "workspace_path_invalid", "path escapes workspace root", {
        path: params.path,
      });
      return;
    }
    const workspaceRoot = await openWorkspaceRoot(resolved.workspaceDir);
    if (!workspaceRoot) {
      respondWorkspaceError(respond, "workspace_unavailable", "agent workspace is unavailable");
      return;
    }
    const mimeType = mimeTypeFromFilePath(relPath);
    const isImage = kindFromMime(mimeType) === "image";
    const maxBytes = isImage ? MAX_IMAGE_READ_BYTES : MAX_TEXT_READ_BYTES;
    let read: Awaited<ReturnType<WorkspaceRoot["read"]>>;
    try {
      read = await workspaceRoot.read(relPath, {
        hardlinks: "reject",
        maxBytes,
        nonBlockingRead: true,
        symlinks: "reject",
      });
    } catch (err) {
      if (err instanceof FsSafeError && err.code === "too-large") {
        respondWorkspaceError(respond, "workspace_file_too_large", "file exceeds the read cap", {
          maxBytes,
          path: relPath,
        });
        return;
      }
      if (err instanceof FsSafeError) {
        respondWorkspaceError(respond, "workspace_path_not_found", "workspace file not found", {
          path: relPath,
        });
        return;
      }
      throw err;
    }
    if (!isImage && read.buffer.includes(0)) {
      respondWorkspaceError(
        respond,
        "workspace_file_unsupported",
        "only UTF-8 text and image files can be previewed",
        { path: relPath },
      );
      return;
    }
    respond(true, {
      agentId: resolved.agentId,
      workspace: resolved.workspaceDir,
      file: {
        path: relPath,
        name: path.posix.basename(relPath),
        size: read.stat.size,
        updatedAtMs: Math.floor(read.stat.mtimeMs),
        encoding: isImage ? "base64" : "utf8",
        ...(mimeType ? { mimeType } : {}),
        content: read.buffer.toString(isImage ? "base64" : "utf8"),
      },
    });
  },
};

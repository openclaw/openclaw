// Read-only browsing for explicitly configured Gateway filesystem roots.
// Clients receive stable root IDs and relative paths, never host paths.
import path from "node:path";
import { detectMime } from "@openclaw/media-core/mime";
import {
  ErrorCodes,
  errorShape,
  type FileRootEntry,
  validateFilesRootGetParams,
  validateFilesRootListParams,
  validateFilesRootsListParams,
} from "../../../packages/gateway-protocol/src/index.js";
import type { GatewayFileRootConfig } from "../../config/types.gateway.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { FsSafeError } from "../../infra/fs-safe.js";
import type { GatewayRequestHandlers, RespondFn } from "./types.js";
import { assertValidParams } from "./validation.js";
import {
  decodeUtf8Strict,
  listWorkspacePath,
  normalizeRelativePath,
  openWorkspaceRoot,
  resolveWorkspacePath,
  sortWorkspaceEntries,
  statWorkspacePath,
  toUpdatedAtMs,
  type WorkspaceRoot,
  WORKSPACE_PREVIEW_MAX_BYTES,
} from "./workspace-fs.js";

const DEFAULT_LIST_LIMIT = 250;
const MAX_LIST_LIMIT = 500;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const IMAGE_EXTENSIONS = new Set([
  ".avif",
  ".bmp",
  ".gif",
  ".heic",
  ".heif",
  ".jpeg",
  ".jpg",
  ".png",
  ".webp",
]);
const SUPPORTED_IMAGE_MIME_TYPES = new Set([
  "image/avif",
  "image/bmp",
  "image/gif",
  "image/heic",
  "image/heif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

function fileRootError(type: string, message: string, details?: Record<string, unknown>) {
  return errorShape(ErrorCodes.INVALID_REQUEST, message, {
    details: { type, ...details },
  });
}

function isHiddenRelativePath(browserPath: string): boolean {
  return browserPath
    .split("/")
    .some((part) => part && part !== "." && part !== ".." && part.startsWith("."));
}

function configuredRoots(cfg: OpenClawConfig): Record<string, GatewayFileRootConfig> {
  return cfg.gateway?.fileRoots ?? {};
}

async function resolveFileRootScope(
  rootId: string,
  rawPath: string | undefined,
  cfg: OpenClawConfig,
  respond: RespondFn,
): Promise<{ rootId: string; root: WorkspaceRoot; browserPath: string } | null> {
  const roots = configuredRoots(cfg);
  const config = roots[rootId];
  if (!Object.hasOwn(roots, rootId) || !config) {
    respond(
      false,
      undefined,
      fileRootError("file_root_not_found", "file root not found", { rootId }),
    );
    return null;
  }
  if (!path.isAbsolute(config.path)) {
    respond(
      false,
      undefined,
      fileRootError("file_root_unavailable", "file root path must be absolute", { rootId }),
    );
    return null;
  }
  const portablePath = (rawPath ?? "").replaceAll("\\", "/");
  if (path.posix.isAbsolute(portablePath) || path.win32.isAbsolute(rawPath ?? "")) {
    respond(
      false,
      undefined,
      fileRootError("file_root_path_invalid", "path must be file-root-relative", {
        rootId,
        path: rawPath ?? "",
      }),
    );
    return null;
  }
  const browserPath = normalizeRelativePath(rawPath);
  if (isHiddenRelativePath(browserPath)) {
    respond(
      false,
      undefined,
      fileRootError("file_root_path_hidden", "hidden file-root metadata is not exposed", {
        rootId,
        path: rawPath ?? "",
      }),
    );
    return null;
  }
  const root = await openWorkspaceRoot(config.path);
  if (!root) {
    respond(
      false,
      undefined,
      fileRootError("file_root_unavailable", "file root is unavailable", { rootId }),
    );
    return null;
  }
  if (!resolveWorkspacePath(root.rootReal, browserPath || ".")) {
    respond(
      false,
      undefined,
      fileRootError("file_root_path_invalid", "path escapes the file root", {
        rootId,
        path: rawPath ?? "",
      }),
    );
    return null;
  }
  return { rootId, root, browserPath };
}

function isVisibleEntry(name: string): boolean {
  return !name.startsWith(".");
}

async function readFileFromRoot(
  root: WorkspaceRoot,
  browserPath: string,
  maxBytes: number,
): Promise<Awaited<ReturnType<WorkspaceRoot["read"]>> | "too-large" | undefined> {
  try {
    return await root.read(browserPath, {
      hardlinks: "reject",
      maxBytes,
      nonBlockingRead: true,
      symlinks: "reject",
    });
  } catch (error) {
    if (error instanceof FsSafeError && error.code === "too-large") {
      return "too-large";
    }
    return undefined;
  }
}

export const fileRootsHandlers: GatewayRequestHandlers = {
  "files.roots.list": async ({ params, respond, context }) => {
    if (!assertValidParams(params, validateFilesRootsListParams, "files.roots.list", respond)) {
      return;
    }
    const roots = await Promise.all(
      Object.entries(configuredRoots(context.getRuntimeConfig())).map(async ([id, config]) => ({
        id,
        label: config.label,
        available: path.isAbsolute(config.path) && Boolean(await openWorkspaceRoot(config.path)),
      })),
    );
    respond(true, { roots });
  },
  "files.root.list": async ({ params, respond, context }) => {
    if (!assertValidParams(params, validateFilesRootListParams, "files.root.list", respond)) {
      return;
    }
    const scope = await resolveFileRootScope(
      params.rootId,
      params.path,
      context.getRuntimeConfig(),
      respond,
    );
    if (!scope) {
      return;
    }
    const stat = await statWorkspacePath(scope.root, scope.browserPath);
    const dirents = stat?.isDirectory
      ? await listWorkspacePath(scope.root, scope.browserPath)
      : undefined;
    if (!dirents) {
      respond(
        false,
        undefined,
        fileRootError("file_root_path_not_found", "file root directory not found", {
          rootId: scope.rootId,
          path: scope.browserPath,
        }),
      );
      return;
    }
    const entries = sortWorkspaceEntries(
      dirents.flatMap((dirent): FileRootEntry[] => {
        if (!isVisibleEntry(dirent.name)) {
          return [];
        }
        const kind = dirent.isFile ? "file" : dirent.isDirectory ? "directory" : null;
        if (!kind) {
          return [];
        }
        return [
          {
            path: scope.browserPath ? `${scope.browserPath}/${dirent.name}` : dirent.name,
            name: dirent.name,
            kind,
            ...(kind === "file" ? { size: dirent.size } : {}),
            updatedAtMs: toUpdatedAtMs(dirent.mtimeMs),
          },
        ];
      }),
    );
    const offset = Math.min(params.offset ?? 0, entries.length);
    const limit = Math.min(params.limit ?? DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
    const parent = path.dirname(scope.browserPath);
    respond(true, {
      rootId: scope.rootId,
      path: scope.browserPath,
      ...(scope.browserPath ? { parentPath: parent === "." ? "" : parent } : {}),
      entries: entries.slice(offset, offset + limit),
      totalEntries: entries.length,
      offset,
    });
  },
  "files.root.get": async ({ params, respond, context }) => {
    if (!assertValidParams(params, validateFilesRootGetParams, "files.root.get", respond)) {
      return;
    }
    const scope = await resolveFileRootScope(
      params.rootId,
      params.path,
      context.getRuntimeConfig(),
      respond,
    );
    if (!scope) {
      return;
    }
    const stat = await statWorkspacePath(scope.root, scope.browserPath);
    if (!stat?.isFile) {
      respond(
        false,
        undefined,
        fileRootError("file_root_file_not_found", "file root file not found", {
          rootId: scope.rootId,
          path: scope.browserPath,
        }),
      );
      return;
    }
    const expectsImage = IMAGE_EXTENSIONS.has(path.extname(scope.browserPath).toLowerCase());
    const maxBytes = expectsImage ? MAX_IMAGE_BYTES : WORKSPACE_PREVIEW_MAX_BYTES;
    const read =
      stat.size > maxBytes
        ? "too-large"
        : await readFileFromRoot(scope.root, scope.browserPath, maxBytes);
    if (read === "too-large") {
      respond(
        false,
        undefined,
        fileRootError("file_root_file_too_large", "file root file is too large to preview", {
          rootId: scope.rootId,
          maxBytes,
          path: scope.browserPath,
          size: stat.size,
        }),
      );
      return;
    }
    if (!read) {
      respond(
        false,
        undefined,
        fileRootError("file_root_file_not_found", "file root file not found", {
          rootId: scope.rootId,
          path: scope.browserPath,
        }),
      );
      return;
    }
    if (expectsImage) {
      const sniffedMime = await detectMime({ buffer: read.buffer });
      if (!sniffedMime || !SUPPORTED_IMAGE_MIME_TYPES.has(sniffedMime)) {
        respond(
          false,
          undefined,
          fileRootError("file_root_file_unsupported", "file root file is not a supported image", {
            rootId: scope.rootId,
            path: scope.browserPath,
          }),
        );
        return;
      }
      respond(true, {
        rootId: scope.rootId,
        file: {
          path: scope.browserPath,
          name: path.basename(scope.browserPath),
          size: read.stat.size,
          updatedAtMs: toUpdatedAtMs(read.stat.mtimeMs),
          mimeType: sniffedMime,
          encoding: "base64" as const,
          content: read.buffer.toString("base64"),
        },
      });
      return;
    }
    const text = decodeUtf8Strict(read.buffer);
    if (text === undefined) {
      respond(
        false,
        undefined,
        fileRootError("file_root_file_unsupported", "file root file is not UTF-8 text", {
          rootId: scope.rootId,
          path: scope.browserPath,
        }),
      );
      return;
    }
    respond(true, {
      rootId: scope.rootId,
      file: {
        path: scope.browserPath,
        name: path.basename(scope.browserPath),
        size: read.stat.size,
        updatedAtMs: toUpdatedAtMs(read.stat.mtimeMs),
        mimeType: "text/plain",
        encoding: "utf8" as const,
        content: text,
      },
    });
  },
};

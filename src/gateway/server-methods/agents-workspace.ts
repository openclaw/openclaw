import fs from "node:fs/promises";
import path from "node:path";
import { listAgentIds, resolveAgentWorkspaceDir } from "../../agents/agent-scope.js";
import {
  mkdirPathWithinRoot,
  readFileWithinRoot,
  removePathWithinRoot,
  writeFileWithinRoot,
} from "../../infra/fs-safe.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateAgentsWorkspaceDeleteParams,
  validateAgentsWorkspaceGetParams,
  validateAgentsWorkspaceListParams,
  validateAgentsWorkspaceMkdirParams,
  validateAgentsWorkspaceMoveParams,
  validateAgentsWorkspaceSetParams,
  validateAgentsWorkspaceStatParams,
} from "../protocol/index.js";
import type { GatewayRequestHandlers, RespondFn } from "./types.js";

const WORKSPACE_FILE_SIZE_LIMIT = 10 * 1024 * 1024; // 10MB

// Helper to resolve agent workspace
function resolveWorkspaceOrError(
  agentIdRaw: string,
  respond: RespondFn,
  cfg: ReturnType<typeof import("../../config/config.js").loadConfig>,
): { agentId: string; workspaceDir: string } | null {
  const agentId = normalizeAgentId(agentIdRaw);

  // Validate agent exists in configured agents list
  const allowed = new Set(listAgentIds(cfg));
  if (!allowed.has(agentId)) {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unknown agent id"));
    return null;
  }

  const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
  return { agentId, workspaceDir };
}

// Helper to validate relative path
function validateRelativePath(pathInput: string): string | null {
  // Remove leading ./
  let normalized = pathInput.replace(/^\.\//, "");

  // Reject .. and absolute paths
  if (normalized.startsWith("..") || normalized.startsWith("/")) {
    return null;
  }

  // Check for .. in path
  const parts = normalized.split(/[/\\]/);
  if (parts.some((p) => p === "..")) {
    return null;
  }

  return normalized;
}

// List directory contents
async function workspaceList(
  workspaceDir: string,
  relativePath: string,
  recursive: boolean,
): Promise<
  Array<{
    name: string;
    path: string;
    type: "file" | "directory" | "symlink";
    size?: number;
    updatedAtMs?: number;
    createdAtMs?: number;
  }>
> {
  const targetPath = path.join(workspaceDir, relativePath);

  // Ensure workspace directory exists (tolerate uncreated workspaces)
  try {
    await fs.access(workspaceDir);
  } catch {
    await fs.mkdir(workspaceDir, { recursive: true });
  }

  // Resolve symlinks and verify the target stays within the workspace root
  const realRoot = await fs.realpath(workspaceDir);
  const realTarget = await fs.realpath(targetPath).catch((err) => {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  });
  if (!realTarget) {
    // Target directory doesn't exist yet, return empty listing
    return [];
  }
  if (!realTarget.startsWith(realRoot + path.sep) && realTarget !== realRoot) {
    throw new Error("Path resolves outside workspace root");
  }

  const entries = [] as Array<{
    name: string;
    path: string;
    type: "file" | "directory" | "symlink";
    size?: number;
    updatedAtMs?: number;
    createdAtMs?: number;
  }>;

  const items = await fs.readdir(targetPath, { withFileTypes: true });

  for (const item of items) {
    const itemPath = path.join(relativePath, item.name).split(path.sep).join("/");
    const fullPath = path.join(workspaceDir, itemPath);

    let type: "file" | "directory" | "symlink";
    if (item.isSymbolicLink()) {
      type = "symlink";
    } else if (item.isDirectory()) {
      type = "directory";
    } else {
      type = "file";
    }

    // Use lstat for symlinks to avoid following links outside workspace root
    const stat = await (type === "symlink" ? fs.lstat(fullPath) : fs.stat(fullPath)).catch(
      () => null,
    );

    entries.push({
      name: item.name,
      path: itemPath,
      type,
      size: stat?.isFile() ? stat.size : undefined,
      updatedAtMs: stat ? Math.floor(stat.mtimeMs) : undefined,
      createdAtMs: stat ? Math.floor(stat.ctimeMs) : undefined,
    });

    if (recursive && type === "directory") {
      const subEntries = await workspaceList(workspaceDir, itemPath, true);
      entries.push(...subEntries);
    }
  }

  return entries;
}

// Read file content
async function workspaceGet(
  workspaceDir: string,
  relativePath: string,
  encoding: "utf8" | "base64",
): Promise<{ content: string; size: number; updatedAtMs?: number }> {
  const result = await readFileWithinRoot({
    rootDir: workspaceDir,
    relativePath,
    maxBytes: WORKSPACE_FILE_SIZE_LIMIT,
  });

  const content =
    encoding === "base64" ? result.buffer.toString("base64") : result.buffer.toString("utf8");

  return {
    content,
    size: result.stat.size,
    updatedAtMs: Math.floor(result.stat.mtimeMs),
  };
}

// Write file content
async function workspaceSet(
  workspaceDir: string,
  relativePath: string,
  content: string,
  encoding: "utf8" | "base64",
  createDirs: boolean,
): Promise<{ size: number; updatedAtMs: number }> {
  const data = encoding === "base64" ? Buffer.from(content, "base64") : content;

  const byteLength = data instanceof Buffer ? data.length : Buffer.byteLength(data, "utf8");
  if (byteLength > WORKSPACE_FILE_SIZE_LIMIT) {
    throw new Error("File exceeds size limit");
  }

  await writeFileWithinRoot({
    rootDir: workspaceDir,
    relativePath,
    data,
    mkdir: createDirs,
  });

  const stat = await fs.stat(path.join(workspaceDir, relativePath));
  return {
    size: stat.size,
    updatedAtMs: Math.floor(stat.mtimeMs),
  };
}

// Delete file/directory
async function workspaceDelete(
  workspaceDir: string,
  relativePath: string,
  recursive: boolean,
): Promise<boolean> {
  const fullPath = path.join(workspaceDir, relativePath);

  try {
    // Use lstat to check the entry itself, not the symlink target
    const lstat = await fs.lstat(fullPath);

    if (lstat.isDirectory() && !recursive) {
      const items = await fs.readdir(fullPath);
      if (items.length > 0) {
        throw new Error("Directory not empty");
      }
    }

    if (lstat.isDirectory() && recursive) {
      // removePathWithinRoot does not support recursive directory removal,
      // so use fs.rm with recursive flag after verifying the path is within root
      const realRoot = await fs.realpath(workspaceDir);
      const realPath = await fs.realpath(fullPath);
      // Block deletion of the workspace root itself
      if (realPath === realRoot) {
        throw new Error("Cannot delete workspace root directory");
      }
      if (!realPath.startsWith(realRoot + path.sep)) {
        throw new Error("Path resolves outside workspace root");
      }
      await fs.rm(fullPath, { recursive: true });
    } else {
      await removePathWithinRoot({
        rootDir: workspaceDir,
        relativePath,
      });
    }

    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw err;
  }
}

// Create directory
async function workspaceMkdir(
  workspaceDir: string,
  relativePath: string,
  parents: boolean,
): Promise<boolean> {
  try {
    if (parents) {
      await mkdirPathWithinRoot({
        rootDir: workspaceDir,
        relativePath,
        allowRoot: false,
      });
    } else {
      // Non-recursive: only create if the parent directory already exists
      const fullPath = path.join(workspaceDir, relativePath);
      // Verify parent stays within workspace root
      const realRoot = await fs.realpath(workspaceDir);
      const parentDir = path.dirname(fullPath);
      const realParent = await fs.realpath(parentDir);
      if (!realParent.startsWith(realRoot + path.sep) && realParent !== realRoot) {
        throw new Error("Path resolves outside workspace root");
      }
      await fs.mkdir(fullPath, { recursive: false });
    }
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      return false;
    }
    throw err;
  }
}

// Move/rename file
async function workspaceMove(
  workspaceDir: string,
  fromPath: string,
  toPath: string,
  overwrite: boolean,
): Promise<void> {
  const fromFullPath = path.join(workspaceDir, fromPath);
  const toFullPath = path.join(workspaceDir, toPath);

  // Enforce workspace boundary: resolve symlinks and verify both paths stay within root
  const realRoot = await fs.realpath(workspaceDir);
  const realFrom = await fs.realpath(fromFullPath);
  if (!realFrom.startsWith(realRoot + path.sep) && realFrom !== realRoot) {
    throw new Error("Source path resolves outside workspace root");
  }
  // Validate destination by walking up to the nearest existing ancestor
  let checkDir = path.dirname(toFullPath);
  while (checkDir !== workspaceDir && checkDir !== path.dirname(checkDir)) {
    try {
      const realDir = await fs.realpath(checkDir);
      if (!realDir.startsWith(realRoot + path.sep) && realDir !== realRoot) {
        throw new Error("Destination path resolves outside workspace root");
      }
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        // Ancestor doesn't exist yet, check its parent
        checkDir = path.dirname(checkDir);
        continue;
      }
      throw err;
    }
  }

  // Check source exists
  await fs.access(fromFullPath);

  // Check destination doesn't exist (unless overwrite) using lstat
  // to detect dangling symlinks and permission-denied entries
  let destExists = false;
  try {
    await fs.lstat(toFullPath);
    destExists = true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }
  if (destExists && !overwrite) {
    throw new Error("Destination already exists");
  }

  // Ensure parent directory exists
  const parentDir = path.dirname(toFullPath);
  await fs.mkdir(parentDir, { recursive: true });

  // Perform move
  await fs.rename(fromFullPath, toFullPath);
}

// Get file metadata
async function workspaceStat(
  workspaceDir: string,
  relativePath: string,
): Promise<{
  type: "file" | "directory" | "symlink";
  size?: number;
  updatedAtMs?: number;
  createdAtMs?: number;
  isWritable: boolean;
}> {
  const fullPath = path.join(workspaceDir, relativePath);

  // Enforce workspace root boundary via realpath
  const realRoot = await fs.realpath(workspaceDir);
  const realPath = await fs.realpath(fullPath).catch(() => null);
  if (realPath && !realPath.startsWith(realRoot + path.sep) && realPath !== realRoot) {
    throw new Error("Path resolves outside workspace root");
  }

  const [stat, lstat] = await Promise.all([
    fs.stat(fullPath).catch(() => null),
    fs.lstat(fullPath).catch(() => null),
  ]);

  // Use lstat as the authoritative existence check so dangling symlinks are still inspectable
  if (!lstat) {
    throw new Error("File not found");
  }

  let type: "file" | "directory" | "symlink";
  if (lstat.isSymbolicLink()) {
    type = "symlink";
  } else if (lstat.isDirectory()) {
    type = "directory";
  } else {
    type = "file";
  }

  // For non-symlinks or resolvable symlinks, use stat for size/timestamps; fall back to lstat
  const metaStat = stat ?? lstat;

  // Check writability
  const isWritable = await fs
    .access(fullPath, fs.constants.W_OK)
    .then(() => true)
    .catch(() => false);

  return {
    type,
    size: metaStat.isFile() ? metaStat.size : undefined,
    updatedAtMs: Math.floor(metaStat.mtimeMs),
    createdAtMs: Math.floor(metaStat.ctimeMs),
    isWritable,
  };
}

export const agentsWorkspaceHandlers: GatewayRequestHandlers = {
  "agents.workspace.list": async ({ params, respond, context }) => {
    if (!validateAgentsWorkspaceListParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid params: ${formatValidationErrors(validateAgentsWorkspaceListParams.errors)}`,
        ),
      );
      return;
    }

    const resolved = resolveWorkspaceOrError(params.agentId, respond, context.getRuntimeConfig());
    if (!resolved) {
      return;
    }

    const { agentId, workspaceDir } = resolved;
    const relativePath = validateRelativePath(params.path || "");

    if (relativePath === null) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "invalid path"));
      return;
    }

    try {
      const entries = await workspaceList(workspaceDir, relativePath, params.recursive || false);

      respond(
        true,
        {
          agentId,
          workspace: workspaceDir,
          path: relativePath,
          entries,
        },
        undefined,
      );
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    }
  },

  "agents.workspace.get": async ({ params, respond, context }) => {
    if (!validateAgentsWorkspaceGetParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid params: ${formatValidationErrors(validateAgentsWorkspaceGetParams.errors)}`,
        ),
      );
      return;
    }

    const resolved = resolveWorkspaceOrError(params.agentId, respond, context.getRuntimeConfig());
    if (!resolved) {
      return;
    }

    const { agentId, workspaceDir } = resolved;
    const relativePath = validateRelativePath(params.path);

    if (relativePath === null) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "invalid path"));
      return;
    }

    try {
      const result = await workspaceGet(workspaceDir, relativePath, params.encoding || "utf8");

      respond(
        true,
        {
          agentId,
          workspace: workspaceDir,
          path: relativePath,
          content: result.content,
          encoding: params.encoding || "utf8",
          size: result.size,
          updatedAtMs: result.updatedAtMs,
        },
        undefined,
      );
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    }
  },

  "agents.workspace.set": async ({ params, respond, context }) => {
    if (!validateAgentsWorkspaceSetParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid params: ${formatValidationErrors(validateAgentsWorkspaceSetParams.errors)}`,
        ),
      );
      return;
    }

    const resolved = resolveWorkspaceOrError(params.agentId, respond, context.getRuntimeConfig());
    if (!resolved) {
      return;
    }

    const { agentId, workspaceDir } = resolved;
    const relativePath = validateRelativePath(params.path);

    if (relativePath === null) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "invalid path"));
      return;
    }

    try {
      const result = await workspaceSet(
        workspaceDir,
        relativePath,
        params.content,
        params.encoding || "utf8",
        params.createDirs || false,
      );

      respond(
        true,
        {
          ok: true,
          agentId,
          path: relativePath,
          size: result.size,
          updatedAtMs: result.updatedAtMs,
        },
        undefined,
      );
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    }
  },

  "agents.workspace.delete": async ({ params, respond, context }) => {
    if (!validateAgentsWorkspaceDeleteParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid params: ${formatValidationErrors(validateAgentsWorkspaceDeleteParams.errors)}`,
        ),
      );
      return;
    }

    const resolved = resolveWorkspaceOrError(params.agentId, respond, context.getRuntimeConfig());
    if (!resolved) {
      return;
    }

    const { agentId, workspaceDir } = resolved;
    const relativePath = validateRelativePath(params.path);

    if (relativePath === null) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "invalid path"));
      return;
    }

    try {
      const deleted = await workspaceDelete(workspaceDir, relativePath, params.recursive || false);

      respond(
        true,
        {
          ok: true,
          agentId,
          path: relativePath,
          deleted,
        },
        undefined,
      );
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    }
  },

  "agents.workspace.mkdir": async ({ params, respond, context }) => {
    if (!validateAgentsWorkspaceMkdirParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid params: ${formatValidationErrors(validateAgentsWorkspaceMkdirParams.errors)}`,
        ),
      );
      return;
    }

    const resolved = resolveWorkspaceOrError(params.agentId, respond, context.getRuntimeConfig());
    if (!resolved) {
      return;
    }

    const { agentId, workspaceDir } = resolved;
    const relativePath = validateRelativePath(params.path);

    if (relativePath === null) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "invalid path"));
      return;
    }

    try {
      const created = await workspaceMkdir(workspaceDir, relativePath, params.parents || false);

      respond(
        true,
        {
          ok: true,
          agentId,
          path: relativePath,
          created,
        },
        undefined,
      );
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    }
  },

  "agents.workspace.move": async ({ params, respond, context }) => {
    if (!validateAgentsWorkspaceMoveParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid params: ${formatValidationErrors(validateAgentsWorkspaceMoveParams.errors)}`,
        ),
      );
      return;
    }

    const resolved = resolveWorkspaceOrError(params.agentId, respond, context.getRuntimeConfig());
    if (!resolved) {
      return;
    }

    const { agentId, workspaceDir } = resolved;
    const fromPath = validateRelativePath(params.from);
    const toPath = validateRelativePath(params.to);

    if (fromPath === null || toPath === null) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "invalid path"));
      return;
    }

    try {
      await workspaceMove(workspaceDir, fromPath, toPath, params.overwrite || false);

      respond(
        true,
        {
          ok: true,
          agentId,
          from: fromPath,
          to: toPath,
        },
        undefined,
      );
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    }
  },

  "agents.workspace.stat": async ({ params, respond, context }) => {
    if (!validateAgentsWorkspaceStatParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid params: ${formatValidationErrors(validateAgentsWorkspaceStatParams.errors)}`,
        ),
      );
      return;
    }

    const resolved = resolveWorkspaceOrError(params.agentId, respond, context.getRuntimeConfig());
    if (!resolved) {
      return;
    }

    const { agentId, workspaceDir } = resolved;
    const relativePath = validateRelativePath(params.path);

    if (relativePath === null) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "invalid path"));
      return;
    }

    try {
      const result = await workspaceStat(workspaceDir, relativePath);

      respond(
        true,
        {
          agentId,
          workspace: workspaceDir,
          path: relativePath,
          type: result.type,
          size: result.size,
          updatedAtMs: result.updatedAtMs,
          createdAtMs: result.createdAtMs,
          isWritable: result.isWritable,
        },
        undefined,
      );
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    }
  },
};

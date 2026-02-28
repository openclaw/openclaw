import fs from "node:fs/promises";
import path from "node:path";
import type { GatewayRequestHandlers } from "./types.js";
import { listAgentIds, resolveAgentWorkspaceDir } from "../../agents/agent-scope.js";
import {
  DEFAULT_AGENTS_FILENAME,
  DEFAULT_BOOTSTRAP_FILENAME,
  DEFAULT_HEARTBEAT_FILENAME,
  DEFAULT_IDENTITY_FILENAME,
  DEFAULT_MEMORY_ALT_FILENAME,
  DEFAULT_MEMORY_FILENAME,
  DEFAULT_SOUL_FILENAME,
  DEFAULT_TOOLS_FILENAME,
  DEFAULT_USER_FILENAME,
} from "../../agents/workspace.js";
import { loadConfig } from "../../config/config.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateAgentsFilesGetParams,
  validateAgentsFilesListParams,
  validateAgentsFilesReadParams,
  validateAgentsFilesSetParams,
  validateAgentsFilesTreeParams,
  validateAgentsListParams,
} from "../protocol/index.js";
import { listAgentsForGateway } from "../session-utils.js";

const BOOTSTRAP_FILE_NAMES = [
  DEFAULT_AGENTS_FILENAME,
  DEFAULT_SOUL_FILENAME,
  DEFAULT_TOOLS_FILENAME,
  DEFAULT_IDENTITY_FILENAME,
  DEFAULT_USER_FILENAME,
  DEFAULT_HEARTBEAT_FILENAME,
  DEFAULT_BOOTSTRAP_FILENAME,
] as const;

const MEMORY_FILE_NAMES = [DEFAULT_MEMORY_FILENAME, DEFAULT_MEMORY_ALT_FILENAME] as const;

const ALLOWED_FILE_NAMES = new Set<string>([...BOOTSTRAP_FILE_NAMES, ...MEMORY_FILE_NAMES]);
const DEFAULT_READ_LIMIT = 16_000;
const MAX_TREE_ENTRIES = 6_000;

const MARKDOWN_EXTENSIONS = new Set([".md", ".markdown"]);

type FileMeta = {
  size: number;
  updatedAtMs: number;
};

type TreeEntry = {
  path: string;
  name: string;
  type: "file" | "dir";
  depth: number;
  markdown?: boolean;
  size?: number;
  updatedAtMs?: number;
};

async function statFile(filePath: string): Promise<FileMeta | null> {
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) {
      return null;
    }
    return {
      size: stat.size,
      updatedAtMs: Math.floor(stat.mtimeMs),
    };
  } catch {
    return null;
  }
}

function isMarkdownFile(fileName: string) {
  return MARKDOWN_EXTENSIONS.has(path.extname(fileName).toLowerCase());
}

function toPosixRelative(workspaceDir: string, targetPath: string): string {
  return path.relative(workspaceDir, targetPath).split(path.sep).join("/");
}

function resolveWorkspacePath(workspaceDir: string, relativePathRaw: string): string | null {
  const relativePath = relativePathRaw.trim().replaceAll("\\", "/");
  if (!relativePath || relativePath.startsWith("/")) {
    return null;
  }
  const root = path.resolve(workspaceDir);
  const absolute = path.resolve(root, relativePath);
  if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) {
    return null;
  }
  return absolute;
}

async function buildWorkspaceTree(workspaceDir: string, includeAll: boolean): Promise<TreeEntry[]> {
  const root = path.resolve(workspaceDir);

  const walk = async (dirAbs: string, depth: number): Promise<{ items: TreeEntry[]; hasMarkdown: boolean }> => {
    let dirents: Awaited<ReturnType<typeof fs.readdir>>;
    try {
      dirents = await fs.readdir(dirAbs, { withFileTypes: true });
    } catch {
      return { items: [], hasMarkdown: false };
    }

    dirents.sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) {
        return -1;
      }
      if (!a.isDirectory() && b.isDirectory()) {
        return 1;
      }
      return a.name.localeCompare(b.name);
    });

    const localItems: TreeEntry[] = [];
    let markdownInTree = false;

    for (const dirent of dirents) {
      if (dirent.name.startsWith(".")) {
        continue;
      }
      const childAbs = path.join(dirAbs, dirent.name);
      const relPath = toPosixRelative(root, childAbs);
      if (!relPath || relPath.startsWith("..")) {
        continue;
      }

      if (dirent.isDirectory()) {
        const nested = await walk(childAbs, depth + 1);
        if (includeAll || nested.items.length > 0) {
          localItems.push({
            path: relPath,
            name: dirent.name,
            type: "dir",
            depth,
          });
          localItems.push(...nested.items);
        }
        if (nested.hasMarkdown) {
          markdownInTree = true;
        }
        continue;
      }

      if (!dirent.isFile()) {
        continue;
      }

      const markdown = isMarkdownFile(dirent.name);
      if (!includeAll && !markdown) {
        continue;
      }

      const meta = await statFile(childAbs);
      localItems.push({
        path: relPath,
        name: dirent.name,
        type: "file",
        depth,
        markdown,
        size: meta?.size,
        updatedAtMs: meta?.updatedAtMs,
      });
      if (markdown) {
        markdownInTree = true;
      }
      if (localItems.length >= MAX_TREE_ENTRIES) {
        break;
      }
    }

    return { items: localItems, hasMarkdown: markdownInTree };
  };

  const result = await walk(root, 0);
  if (result.items.length > MAX_TREE_ENTRIES) {
    return result.items.slice(0, MAX_TREE_ENTRIES);
  }
  return result.items;
}

async function listAgentFiles(workspaceDir: string) {
  const files: Array<{
    name: string;
    path: string;
    missing: boolean;
    size?: number;
    updatedAtMs?: number;
  }> = [];

  for (const name of BOOTSTRAP_FILE_NAMES) {
    const filePath = path.join(workspaceDir, name);
    const meta = await statFile(filePath);
    if (meta) {
      files.push({
        name,
        path: filePath,
        missing: false,
        size: meta.size,
        updatedAtMs: meta.updatedAtMs,
      });
    } else {
      files.push({ name, path: filePath, missing: true });
    }
  }

  const primaryMemoryPath = path.join(workspaceDir, DEFAULT_MEMORY_FILENAME);
  const primaryMeta = await statFile(primaryMemoryPath);
  if (primaryMeta) {
    files.push({
      name: DEFAULT_MEMORY_FILENAME,
      path: primaryMemoryPath,
      missing: false,
      size: primaryMeta.size,
      updatedAtMs: primaryMeta.updatedAtMs,
    });
  } else {
    const altMemoryPath = path.join(workspaceDir, DEFAULT_MEMORY_ALT_FILENAME);
    const altMeta = await statFile(altMemoryPath);
    if (altMeta) {
      files.push({
        name: DEFAULT_MEMORY_ALT_FILENAME,
        path: altMemoryPath,
        missing: false,
        size: altMeta.size,
        updatedAtMs: altMeta.updatedAtMs,
      });
    } else {
      files.push({ name: DEFAULT_MEMORY_FILENAME, path: primaryMemoryPath, missing: true });
    }
  }

  return files;
}

function resolveAgentIdOrError(agentIdRaw: string, cfg: ReturnType<typeof loadConfig>) {
  const agentId = normalizeAgentId(agentIdRaw);
  const allowed = new Set(listAgentIds(cfg));
  if (!allowed.has(agentId)) {
    return null;
  }
  return agentId;
}

export const agentsHandlers: GatewayRequestHandlers = {
  "agents.list": ({ params, respond }) => {
    if (!validateAgentsListParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid agents.list params: ${formatValidationErrors(validateAgentsListParams.errors)}`,
        ),
      );
      return;
    }

    const cfg = loadConfig();
    const result = listAgentsForGateway(cfg);
    respond(true, result, undefined);
  },
  "agents.files.list": async ({ params, respond }) => {
    if (!validateAgentsFilesListParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid agents.files.list params: ${formatValidationErrors(
            validateAgentsFilesListParams.errors,
          )}`,
        ),
      );
      return;
    }
    const cfg = loadConfig();
    const agentId = resolveAgentIdOrError(String(params.agentId ?? ""), cfg);
    if (!agentId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unknown agent id"));
      return;
    }
    const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
    const files = await listAgentFiles(workspaceDir);
    respond(true, { agentId, workspace: workspaceDir, files }, undefined);
  },
  "agents.files.get": async ({ params, respond }) => {
    if (!validateAgentsFilesGetParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid agents.files.get params: ${formatValidationErrors(
            validateAgentsFilesGetParams.errors,
          )}`,
        ),
      );
      return;
    }
    const cfg = loadConfig();
    const agentId = resolveAgentIdOrError(String(params.agentId ?? ""), cfg);
    if (!agentId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unknown agent id"));
      return;
    }
    const name = String(params.name ?? "").trim();
    if (!ALLOWED_FILE_NAMES.has(name)) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `unsupported file "${name}"`),
      );
      return;
    }
    const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
    const filePath = path.join(workspaceDir, name);
    const meta = await statFile(filePath);
    if (!meta) {
      respond(
        true,
        {
          agentId,
          workspace: workspaceDir,
          file: { name, path: filePath, missing: true },
        },
        undefined,
      );
      return;
    }
    const content = await fs.readFile(filePath, "utf-8");
    respond(
      true,
      {
        agentId,
        workspace: workspaceDir,
        file: {
          name,
          path: filePath,
          missing: false,
          size: meta.size,
          updatedAtMs: meta.updatedAtMs,
          content,
        },
      },
      undefined,
    );
  },
  "agents.files.set": async ({ params, respond }) => {
    if (!validateAgentsFilesSetParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid agents.files.set params: ${formatValidationErrors(
            validateAgentsFilesSetParams.errors,
          )}`,
        ),
      );
      return;
    }
    const cfg = loadConfig();
    const agentId = resolveAgentIdOrError(String(params.agentId ?? ""), cfg);
    if (!agentId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unknown agent id"));
      return;
    }
    const name = String(params.name ?? "").trim();
    if (!ALLOWED_FILE_NAMES.has(name)) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `unsupported file "${name}"`),
      );
      return;
    }
    const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
    await fs.mkdir(workspaceDir, { recursive: true });
    const filePath = path.join(workspaceDir, name);
    const content = String(params.content ?? "");
    await fs.writeFile(filePath, content, "utf-8");
    const meta = await statFile(filePath);
    respond(
      true,
      {
        ok: true,
        agentId,
        workspace: workspaceDir,
        file: {
          name,
          path: filePath,
          missing: false,
          size: meta?.size,
          updatedAtMs: meta?.updatedAtMs,
          content,
        },
      },
      undefined,
    );
  },
  "agents.files.tree": async ({ params, respond }) => {
    if (!validateAgentsFilesTreeParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid agents.files.tree params: ${formatValidationErrors(
            validateAgentsFilesTreeParams.errors,
          )}`,
        ),
      );
      return;
    }
    const cfg = loadConfig();
    const agentId = resolveAgentIdOrError(String(params.agentId ?? ""), cfg);
    if (!agentId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unknown agent id"));
      return;
    }
    const includeAll = Boolean(params.includeAll);
    const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
    const entries = await buildWorkspaceTree(workspaceDir, includeAll);
    const fileEntries = entries.filter((entry) => entry.type === "file");
    const markdownCount = fileEntries.filter((entry) => entry.markdown).length;
    respond(
      true,
      {
        agentId,
        workspace: workspaceDir,
        includeAll,
        entries,
        markdownCount,
        fileCount: fileEntries.length,
        dirCount: entries.length - fileEntries.length,
      },
      undefined,
    );
  },
  "agents.files.read": async ({ params, respond }) => {
    if (!validateAgentsFilesReadParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid agents.files.read params: ${formatValidationErrors(
            validateAgentsFilesReadParams.errors,
          )}`,
        ),
      );
      return;
    }
    const cfg = loadConfig();
    const agentId = resolveAgentIdOrError(String(params.agentId ?? ""), cfg);
    if (!agentId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unknown agent id"));
      return;
    }

    const relativePath = String(params.path ?? "").trim();
    const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
    const filePath = resolveWorkspacePath(workspaceDir, relativePath);
    if (!filePath) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "invalid file path"));
      return;
    }

    let stat;
    try {
      stat = await fs.stat(filePath);
    } catch {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "file not found"));
      return;
    }
    if (!stat.isFile()) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "path is not a file"));
      return;
    }

    const content = await fs.readFile(filePath, "utf-8");
    const totalChars = content.length;
    const offsetRaw = Number(params.offset ?? 0);
    const limitRaw = Number(params.limit ?? DEFAULT_READ_LIMIT);
    const offset = Number.isFinite(offsetRaw) ? Math.max(0, Math.floor(offsetRaw)) : 0;
    const limit = Number.isFinite(limitRaw)
      ? Math.max(1, Math.min(200_000, Math.floor(limitRaw)))
      : DEFAULT_READ_LIMIT;

    const chunk = content.slice(offset, offset + limit);
    const nextOffset = offset + chunk.length;
    const truncated = nextOffset < totalChars;

    respond(
      true,
      {
        agentId,
        workspace: workspaceDir,
        file: {
          path: toPosixRelative(path.resolve(workspaceDir), filePath),
          name: path.basename(filePath),
          size: stat.size,
          updatedAtMs: Math.floor(stat.mtimeMs),
          markdown: isMarkdownFile(filePath),
        },
        content: chunk,
        offset,
        limit,
        totalChars,
        truncated,
        nextOffset: truncated ? nextOffset : undefined,
      },
      undefined,
    );
  },
};

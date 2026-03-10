import fs from "node:fs/promises";
import path from "node:path";
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
  isWorkspaceOnboardingCompleted,
} from "../../agents/workspace.js";
import { loadConfig } from "../../config/config.js";
import { sameFileIdentity } from "../../infra/file-identity.js";
import { SafeOpenError, readLocalFileSafely, writeFileWithinRoot } from "../../infra/fs-safe.js";
import { assertNoPathAliasEscape } from "../../infra/path-alias-guards.js";
import { isNotFoundPathError } from "../../infra/path-guards.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateAgentsFilesGetParams,
  validateAgentsFilesListParams,
  validateAgentsFilesSetParams,
  validateAgentsListParams,
} from "../protocol/index.js";
import { listAgentsForGateway } from "../session-utils.js";
import type { GatewayRequestHandlers, RespondFn } from "./types.js";

const BOOTSTRAP_FILE_NAMES = [
  DEFAULT_AGENTS_FILENAME,
  DEFAULT_SOUL_FILENAME,
  DEFAULT_TOOLS_FILENAME,
  DEFAULT_IDENTITY_FILENAME,
  DEFAULT_USER_FILENAME,
  DEFAULT_HEARTBEAT_FILENAME,
  DEFAULT_BOOTSTRAP_FILENAME,
] as const;
const BOOTSTRAP_FILE_NAMES_POST_ONBOARDING = BOOTSTRAP_FILE_NAMES.filter(
  (name) => name !== DEFAULT_BOOTSTRAP_FILENAME,
);

const MEMORY_FILE_NAMES = [DEFAULT_MEMORY_FILENAME, DEFAULT_MEMORY_ALT_FILENAME] as const;

const ALLOWED_FILE_NAMES = new Set<string>([...BOOTSTRAP_FILE_NAMES, ...MEMORY_FILE_NAMES]);

function resolveAgentWorkspaceFileOrRespondError(
  params: Record<string, unknown>,
  respond: RespondFn,
): {
  cfg: ReturnType<typeof loadConfig>;
  agentId: string;
  workspaceDir: string;
  name: string;
} | null {
  const cfg = loadConfig();
  const rawAgentId = params.agentId;
  const agentId = resolveAgentIdOrError(
    typeof rawAgentId === "string" || typeof rawAgentId === "number" ? String(rawAgentId) : "",
    cfg,
  );
  if (!agentId) {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unknown agent id"));
    return null;
  }
  const rawName = params.name;
  const name = (
    typeof rawName === "string" || typeof rawName === "number" ? String(rawName) : ""
  ).trim();
  // Allow exact bootstrap/memory filenames and daily memory files (memory/*.md)
  const isAllowedMemorySubfile = /^memory\/[a-z0-9._-]+\.md$/i.test(name);
  if (!ALLOWED_FILE_NAMES.has(name) && !isAllowedMemorySubfile) {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, `unsupported file "${name}"`));
    return null;
  }
  const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
  return { cfg, agentId, workspaceDir, name };
}

type FileMeta = {
  size: number;
  updatedAtMs: number;
};

type ResolvedAgentWorkspaceFilePath =
  | {
      kind: "ready";
      requestPath: string;
      ioPath: string;
      workspaceReal: string;
    }
  | {
      kind: "missing";
      requestPath: string;
      ioPath: string;
      workspaceReal: string;
    }
  | {
      kind: "invalid";
      requestPath: string;
      reason: string;
    };

type ResolvedWorkspaceFilePath = Exclude<ResolvedAgentWorkspaceFilePath, { kind: "invalid" }>;

function resolveNotFoundWorkspaceFilePathResult(params: {
  error: unknown;
  allowMissing: boolean;
  requestPath: string;
  ioPath: string;
  workspaceReal: string;
}): Extract<ResolvedAgentWorkspaceFilePath, { kind: "missing" | "invalid" }> | undefined {
  if (!isNotFoundPathError(params.error)) {
    return undefined;
  }
  if (params.allowMissing) {
    return {
      kind: "missing",
      requestPath: params.requestPath,
      ioPath: params.ioPath,
      workspaceReal: params.workspaceReal,
    };
  }
  return { kind: "invalid", requestPath: params.requestPath, reason: "file not found" };
}

function resolveWorkspaceFilePathResultOrThrow(params: {
  error: unknown;
  allowMissing: boolean;
  requestPath: string;
  ioPath: string;
  workspaceReal: string;
}): Extract<ResolvedAgentWorkspaceFilePath, { kind: "missing" | "invalid" }> {
  const notFoundResult = resolveNotFoundWorkspaceFilePathResult(params);
  if (notFoundResult) {
    return notFoundResult;
  }
  throw params.error;
}

async function resolveWorkspaceRealPath(workspaceDir: string): Promise<string> {
  try {
    return await fs.realpath(workspaceDir);
  } catch {
    return path.resolve(workspaceDir);
  }
}

async function resolveAgentWorkspaceFilePath(params: {
  workspaceDir: string;
  name: string;
  allowMissing: boolean;
}): Promise<ResolvedAgentWorkspaceFilePath> {
  const requestPath = path.join(params.workspaceDir, params.name);
  const workspaceReal = await resolveWorkspaceRealPath(params.workspaceDir);
  const candidatePath = path.resolve(workspaceReal, params.name);

  try {
    await assertNoPathAliasEscape({
      absolutePath: candidatePath,
      rootPath: workspaceReal,
      boundaryLabel: "workspace root",
    });
  } catch (error) {
    return {
      kind: "invalid",
      requestPath,
      reason: error instanceof Error ? error.message : "path escapes workspace root",
    };
  }

  const notFoundContext = {
    allowMissing: params.allowMissing,
    requestPath,
    workspaceReal,
  } as const;

  let candidateLstat: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    candidateLstat = await fs.lstat(candidatePath);
  } catch (err) {
    return resolveWorkspaceFilePathResultOrThrow({
      error: err,
      ...notFoundContext,
      ioPath: candidatePath,
    });
  }

  if (candidateLstat.isSymbolicLink()) {
    let targetReal: string;
    try {
      targetReal = await fs.realpath(candidatePath);
    } catch (err) {
      return resolveWorkspaceFilePathResultOrThrow({
        error: err,
        ...notFoundContext,
        ioPath: candidatePath,
      });
    }
    let targetStat: Awaited<ReturnType<typeof fs.stat>>;
    try {
      targetStat = await fs.stat(targetReal);
    } catch (err) {
      return resolveWorkspaceFilePathResultOrThrow({
        error: err,
        ...notFoundContext,
        ioPath: targetReal,
      });
    }
    if (!targetStat.isFile()) {
      return { kind: "invalid", requestPath, reason: "path is not a regular file" };
    }
    if (targetStat.nlink > 1) {
      return { kind: "invalid", requestPath, reason: "hardlinked file path not allowed" };
    }
    return { kind: "ready", requestPath, ioPath: targetReal, workspaceReal };
  }

  if (!candidateLstat.isFile()) {
    return { kind: "invalid", requestPath, reason: "path is not a regular file" };
  }
  if (candidateLstat.nlink > 1) {
    return { kind: "invalid", requestPath, reason: "hardlinked file path not allowed" };
  }

  const targetReal = await fs.realpath(candidatePath).catch(() => candidatePath);
  return { kind: "ready", requestPath, ioPath: targetReal, workspaceReal };
}

async function statFileSafely(filePath: string): Promise<FileMeta | null> {
  try {
    const [stat, lstat] = await Promise.all([fs.stat(filePath), fs.lstat(filePath)]);
    if (lstat.isSymbolicLink() || !stat.isFile()) {
      return null;
    }
    if (stat.nlink > 1) {
      return null;
    }
    if (!sameFileIdentity(stat, lstat)) {
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

async function listAgentFiles(workspaceDir: string, options?: { hideBootstrap?: boolean }) {
  const files: Array<{
    name: string;
    path: string;
    missing: boolean;
    size?: number;
    updatedAtMs?: number;
  }> = [];

  const bootstrapFileNames = options?.hideBootstrap
    ? BOOTSTRAP_FILE_NAMES_POST_ONBOARDING
    : BOOTSTRAP_FILE_NAMES;
  for (const name of bootstrapFileNames) {
    const resolved = await resolveAgentWorkspaceFilePath({
      workspaceDir,
      name,
      allowMissing: true,
    });
    const filePath = resolved.requestPath;
    const meta =
      resolved.kind === "ready"
        ? await statFileSafely(resolved.ioPath)
        : resolved.kind === "missing"
          ? null
          : null;
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

  const primaryResolved = await resolveAgentWorkspaceFilePath({
    workspaceDir,
    name: DEFAULT_MEMORY_FILENAME,
    allowMissing: true,
  });
  const primaryMeta =
    primaryResolved.kind === "ready" ? await statFileSafely(primaryResolved.ioPath) : null;
  if (primaryMeta) {
    files.push({
      name: DEFAULT_MEMORY_FILENAME,
      path: primaryResolved.requestPath,
      missing: false,
      size: primaryMeta.size,
      updatedAtMs: primaryMeta.updatedAtMs,
    });
  } else {
    const altMemoryResolved = await resolveAgentWorkspaceFilePath({
      workspaceDir,
      name: DEFAULT_MEMORY_ALT_FILENAME,
      allowMissing: true,
    });
    const altMeta =
      altMemoryResolved.kind === "ready" ? await statFileSafely(altMemoryResolved.ioPath) : null;
    if (altMeta) {
      files.push({
        name: DEFAULT_MEMORY_ALT_FILENAME,
        path: altMemoryResolved.requestPath,
        missing: false,
        size: altMeta.size,
        updatedAtMs: altMeta.updatedAtMs,
      });
    } else {
      files.push({
        name: DEFAULT_MEMORY_FILENAME,
        path: primaryResolved.requestPath,
        missing: true,
      });
    }
  }

  // Scan memory/ subdirectory for daily memory files (e.g. memory/2026-03-06.md)
  const memorySubdir = path.join(workspaceDir, "memory");
  try {
    const memoryDirEntries = await fs.readdir(memorySubdir);
    const mdFiles = memoryDirEntries
      .filter((f) => f.endsWith(".md"))
      .toSorted()
      .toReversed(); // newest first
    for (const mdFile of mdFiles) {
      const relName = `memory/${mdFile}`;
      const fullPath = path.join(memorySubdir, mdFile);
      const meta = await statFileSafely(fullPath);
      if (meta) {
        files.push({
          name: relName,
          path: path.join(workspaceDir, relName),
          missing: false,
          size: meta.size,
          updatedAtMs: meta.updatedAtMs,
        });
      }
    }
  } catch {
    // memory/ subdir may not exist — that's fine
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

function respondInvalidMethodParams(
  respond: RespondFn,
  method: string,
  errors: Parameters<typeof formatValidationErrors>[0],
): void {
  respond(
    false,
    undefined,
    errorShape(
      ErrorCodes.INVALID_REQUEST,
      `invalid ${method} params: ${formatValidationErrors(errors)}`,
    ),
  );
}

function respondWorkspaceFileInvalid(respond: RespondFn, name: string, reason: string): void {
  respond(
    false,
    undefined,
    errorShape(ErrorCodes.INVALID_REQUEST, `unsafe workspace file "${name}" (${reason})`),
  );
}

async function resolveWorkspaceFilePathOrRespond(params: {
  respond: RespondFn;
  workspaceDir: string;
  name: string;
}): Promise<ResolvedWorkspaceFilePath | undefined> {
  const resolvedPath = await resolveAgentWorkspaceFilePath({
    workspaceDir: params.workspaceDir,
    name: params.name,
    allowMissing: true,
  });
  if (resolvedPath.kind === "invalid") {
    respondWorkspaceFileInvalid(params.respond, params.name, resolvedPath.reason);
    return undefined;
  }
  return resolvedPath;
}

function respondWorkspaceFileUnsafe(respond: RespondFn, name: string): void {
  respond(
    false,
    undefined,
    errorShape(ErrorCodes.INVALID_REQUEST, `unsafe workspace file "${name}"`),
  );
}

function respondWorkspaceFileMissing(params: {
  respond: RespondFn;
  agentId: string;
  workspaceDir: string;
  name: string;
  filePath: string;
}): void {
  params.respond(
    true,
    {
      agentId: params.agentId,
      workspace: params.workspaceDir,
      file: { name: params.name, path: params.filePath, missing: true },
    },
    undefined,
  );
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
    let hideBootstrap = false;
    try {
      hideBootstrap = await isWorkspaceOnboardingCompleted(workspaceDir);
    } catch {
      // Fall back to showing BOOTSTRAP if workspace state cannot be read.
    }
    const files = await listAgentFiles(workspaceDir, { hideBootstrap });
    respond(true, { agentId, workspace: workspaceDir, files }, undefined);
  },
  "agents.files.get": async ({ params, respond }) => {
    if (!validateAgentsFilesGetParams(params)) {
      respondInvalidMethodParams(respond, "agents.files.get", validateAgentsFilesGetParams.errors);
      return;
    }
    const resolved = resolveAgentWorkspaceFileOrRespondError(params, respond);
    if (!resolved) {
      return;
    }
    const { agentId, workspaceDir, name } = resolved;
    const filePath = path.join(workspaceDir, name);
    const resolvedPath = await resolveWorkspaceFilePathOrRespond({
      respond,
      workspaceDir,
      name,
    });
    if (!resolvedPath) {
      return;
    }
    if (resolvedPath.kind === "missing") {
      respondWorkspaceFileMissing({ respond, agentId, workspaceDir, name, filePath });
      return;
    }
    let safeRead: Awaited<ReturnType<typeof readLocalFileSafely>>;
    try {
      safeRead = await readLocalFileSafely({ filePath: resolvedPath.ioPath });
    } catch (err) {
      if (err instanceof SafeOpenError && err.code === "not-found") {
        respondWorkspaceFileMissing({ respond, agentId, workspaceDir, name, filePath });
        return;
      }
      respondWorkspaceFileUnsafe(respond, name);
      return;
    }
    respond(
      true,
      {
        agentId,
        workspace: workspaceDir,
        file: {
          name,
          path: filePath,
          missing: false,
          size: safeRead.stat.size,
          updatedAtMs: Math.floor(safeRead.stat.mtimeMs),
          content: safeRead.buffer.toString("utf-8"),
        },
      },
      undefined,
    );
  },
  "agents.files.set": async ({ params, respond }) => {
    if (!validateAgentsFilesSetParams(params)) {
      respondInvalidMethodParams(respond, "agents.files.set", validateAgentsFilesSetParams.errors);
      return;
    }
    const resolved = resolveAgentWorkspaceFileOrRespondError(params, respond);
    if (!resolved) {
      return;
    }
    const { agentId, workspaceDir, name } = resolved;
    await fs.mkdir(workspaceDir, { recursive: true });
    const filePath = path.join(workspaceDir, name);
    const resolvedPath = await resolveWorkspaceFilePathOrRespond({
      respond,
      workspaceDir,
      name,
    });
    if (!resolvedPath) {
      return;
    }
    const content = String(params.content ?? "");
    const relativeWritePath = path.relative(resolvedPath.workspaceReal, resolvedPath.ioPath);
    if (
      !relativeWritePath ||
      relativeWritePath.startsWith("..") ||
      path.isAbsolute(relativeWritePath)
    ) {
      respondWorkspaceFileUnsafe(respond, name);
      return;
    }
    try {
      await writeFileWithinRoot({
        rootDir: resolvedPath.workspaceReal,
        relativePath: relativeWritePath,
        data: content,
        encoding: "utf8",
      });
    } catch {
      respondWorkspaceFileUnsafe(respond, name);
      return;
    }
    const meta = await statFileSafely(resolvedPath.ioPath);
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
};

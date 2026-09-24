import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  ErrorCodes,
  errorShape,
  validateAgentsFilesGetParams,
  validateAgentsFilesListParams,
  validateAgentsFilesSetParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { listAgentIds, resolveAgentWorkspaceDir } from "../../agents/agent-scope.js";
import { getAgentWorkspaceAccess } from "../../agents/workspace-access.js";
import { MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES } from "../../agents/workspace-bootstrap-read.js";
import {
  DEFAULT_BOOTSTRAP_FILENAME,
  DEFAULT_IDENTITY_FILENAME,
  isExpectedAbsentBootstrapFile,
  isWorkspaceSetupCompleted,
  WORKSPACE_BOOTSTRAP_FILENAMES,
} from "../../agents/workspace.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { isMissingPathError } from "../../infra/errors.js";
import { root, FsSafeError, type ReadResult } from "../../infra/fs-safe.js";
import { normalizeAgentIdStrict } from "../../routing/session-key.js";
import type { GatewayRequestHandlers, RespondFn } from "./types.js";
import { assertValidParams } from "./validation.js";
import { enqueueWorkspaceFileUpdate } from "./workspace-fs.js";

// Derived from the canonical workspace list so retiring a bootstrap file cannot
// leave the Control UI advertising a file the runtime no longer reads.
// IDENTITY.md is excluded: it is a parsed record that `agents.update` rewrites via
// mergeIdentityMarkdownContent, so a second freeform editor would clobber fields
// (Creature/Vibe, unfilled placeholders) that the identity form round-trips.
// It stays writable through agents.files.set for clients that want raw access.
const CORE_FILE_NAMES = WORKSPACE_BOOTSTRAP_FILENAMES.filter(
  (name) => name !== DEFAULT_IDENTITY_FILENAME,
);
const CORE_FILE_NAMES_POST_ONBOARDING = CORE_FILE_NAMES.filter(
  (name) => name !== DEFAULT_BOOTSTRAP_FILENAME,
);

// Writes stay capped to canonical workspace files, and deliberately remain wider
// than the listed core files: IDENTITY.md is not offered as an editor tab but is
// still writable for clients that manage it directly.
const ALLOWED_FILE_NAMES = new Set<string>(WORKSPACE_BOOTSTRAP_FILENAMES);

function resolveAgentIdOrError(agentIdRaw: string, cfg: OpenClawConfig) {
  const normalized = normalizeAgentIdStrict(agentIdRaw);
  if (!normalized.ok) {
    return null;
  }
  const agentId = normalized.value;
  const allowed = new Set(listAgentIds(cfg));
  if (!allowed.has(agentId)) {
    return null;
  }
  return agentId;
}

function respondAgentNotFound(respond: RespondFn, agentId: string): void {
  respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, `agent "${agentId}" not found`));
}

function resolveAgentWorkspaceFileOrRespondError(
  params: Record<string, unknown>,
  respond: RespondFn,
  cfg: OpenClawConfig,
): {
  agentId: string;
  workspaceDir: string;
  name: string;
} | null {
  const rawAgentId = params.agentId;
  const agentId = resolveAgentIdOrError(
    typeof rawAgentId === "string" || typeof rawAgentId === "number" ? String(rawAgentId) : "",
    cfg,
  );
  if (!agentId) {
    respondAgentNotFound(respond, String(rawAgentId));
    return null;
  }
  const rawName = params.name;
  const name = (
    typeof rawName === "string" || typeof rawName === "number" ? String(rawName) : ""
  ).trim();
  if (!ALLOWED_FILE_NAMES.has(name)) {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, `unsupported file "${name}"`));
    return null;
  }
  return { agentId, workspaceDir: resolveAgentWorkspaceDir(cfg, agentId), name };
}

type FileMeta = {
  size: number;
  updatedAtMs: number;
};

type WorkspaceRoot = Awaited<ReturnType<typeof root>>;

function isRegularWorkspaceFileStat(stat: {
  isFile: boolean | (() => boolean);
  isSymbolicLink: boolean | (() => boolean);
  nlink: number;
}): boolean {
  const isFile = typeof stat.isFile === "function" ? stat.isFile() : stat.isFile;
  const isSymbolicLink =
    typeof stat.isSymbolicLink === "function" ? stat.isSymbolicLink() : stat.isSymbolicLink;
  // Reject links even after path-root containment so workspace reads cannot follow shared files.
  return isFile && !isSymbolicLink && stat.nlink <= 1;
}

function toWorkspaceFileMeta(
  stat: {
    size: number;
    mtimeMs: number;
  } & Parameters<typeof isRegularWorkspaceFileStat>[0],
): FileMeta | null {
  if (!isRegularWorkspaceFileStat(stat)) {
    return null;
  }
  return {
    size: stat.size,
    updatedAtMs: Math.floor(stat.mtimeMs),
  };
}

async function statWorkspaceFileSafely(
  workspaceRoot: WorkspaceRoot | null,
  workspaceDir: string,
  name: string,
): Promise<FileMeta | null> {
  try {
    const stat = workspaceRoot
      ? await workspaceRoot.stat(name)
      : await fs.lstat(path.join(workspaceDir, name));
    return toWorkspaceFileMeta(stat);
  } catch {
    if (!workspaceRoot) {
      return null;
    }
    try {
      // fs-safe roots can reject fixtures that are still valid regular files for listing metadata.
      const stat = await fs.lstat(path.join(workspaceDir, name));
      return toWorkspaceFileMeta(stat);
    } catch {
      return null;
    }
  }
}

async function openWorkspaceRootSafely(workspaceDir: string): Promise<WorkspaceRoot | null> {
  try {
    return await root(workspaceDir);
  } catch {
    return null;
  }
}

async function listAgentFiles(workspaceDir: string, options?: { hideBootstrap?: boolean }) {
  const access = getAgentWorkspaceAccess(workspaceDir);
  if (access) {
    const names = options?.hideBootstrap ? CORE_FILE_NAMES_POST_ONBOARDING : CORE_FILE_NAMES;
    return await Promise.all(
      names.map(async (name) => {
        const stat = await access.bridge.stat({ filePath: name });
        if (getAgentWorkspaceAccess(workspaceDir) !== access) {
          throw new Error("Workspace access changed while listing Agent documents");
        }
        const file = stat?.type === "file" ? stat : undefined;
        return {
          name,
          path: path.join(workspaceDir, name),
          missing: file === undefined,
          expectedAbsent: file === undefined ? isExpectedAbsentBootstrapFile(name) : undefined,
          size: file?.size,
          updatedAtMs: file === undefined ? undefined : Math.floor(file.mtimeMs),
        };
      }),
    );
  }
  const files: Array<{
    name: string;
    path: string;
    missing: boolean;
    expectedAbsent?: boolean;
    size?: number;
    updatedAtMs?: number;
  }> = [];

  const workspaceRoot = await openWorkspaceRootSafely(workspaceDir);
  if (!workspaceRoot) {
    // Keep the UI shape stable when the workspace path is missing or unsafe.
    const missingNames = options?.hideBootstrap ? CORE_FILE_NAMES_POST_ONBOARDING : CORE_FILE_NAMES;
    return missingNames.map((name) => ({
      name,
      path: path.join(workspaceDir, name),
      missing: true,
      expectedAbsent: isExpectedAbsentBootstrapFile(name),
    }));
  }

  const coreFileNames = options?.hideBootstrap ? CORE_FILE_NAMES_POST_ONBOARDING : CORE_FILE_NAMES;
  for (const name of coreFileNames) {
    const filePath = path.join(workspaceDir, name);
    const meta = await statWorkspaceFileSafely(workspaceRoot, workspaceDir, name);
    if (meta) {
      files.push({
        name,
        path: filePath,
        missing: false,
        size: meta.size,
        updatedAtMs: meta.updatedAtMs,
      });
    } else {
      files.push({
        name,
        path: filePath,
        missing: true,
        expectedAbsent: isExpectedAbsentBootstrapFile(name),
      });
    }
  }

  return files;
}

function hashWorkspaceFileContent(content: Buffer | string): string {
  return createHash("sha256").update(content).digest("hex");
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
      // Clients merge this entry over the listed one, so it must carry the same
      // absence classification or a picked optional file re-renders as a fault.
      file: {
        name: params.name,
        path: params.filePath,
        missing: true,
        expectedAbsent: isExpectedAbsentBootstrapFile(params.name),
      },
    },
    undefined,
  );
}

async function readWorkspaceFileHash(
  workspaceRoot: WorkspaceRoot,
  name: string,
): Promise<string | undefined> {
  try {
    const safeRead = await workspaceRoot.read(name, {
      hardlinks: "reject",
      nonBlockingRead: true,
    });
    return hashWorkspaceFileContent(safeRead.buffer);
  } catch (err) {
    if (isMissingPathError(err)) {
      return undefined;
    }
    throw err;
  }
}

function respondWorkspaceFileConflict(
  respond: RespondFn,
  name: string,
  currentHash: string | undefined,
) {
  respond(
    false,
    undefined,
    errorShape(ErrorCodes.INVALID_REQUEST, `agent file "${name}" changed since it was read`, {
      details: {
        type: "agent_file_conflict",
        name,
        ...(currentHash ? { currentHash } : {}),
      },
    }),
  );
}

export const agentFileHandlers: Pick<
  GatewayRequestHandlers,
  "agents.files.list" | "agents.files.get" | "agents.files.set"
> = {
  "agents.files.list": async ({ params, respond, context }) => {
    if (!assertValidParams(params, validateAgentsFilesListParams, "agents.files.list", respond)) {
      return;
    }
    const cfg = context.getRuntimeConfig();
    const agentId = resolveAgentIdOrError(params.agentId, cfg);
    if (!agentId) {
      respondAgentNotFound(respond, params.agentId);
      return;
    }
    const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
    let hideBootstrap = false;
    try {
      hideBootstrap = await isWorkspaceSetupCompleted(workspaceDir);
    } catch {
      // Fall back to showing BOOTSTRAP if workspace state cannot be read.
    }
    const files = await listAgentFiles(workspaceDir, { hideBootstrap });
    respond(true, { agentId, workspace: workspaceDir, files }, undefined);
  },
  "agents.files.get": async ({ params, respond, context }) => {
    if (!assertValidParams(params, validateAgentsFilesGetParams, "agents.files.get", respond)) {
      return;
    }
    const resolved = resolveAgentWorkspaceFileOrRespondError(
      params,
      respond,
      context.getRuntimeConfig(),
    );
    if (!resolved) {
      return;
    }
    const { agentId, workspaceDir, name } = resolved;
    const filePath = path.join(workspaceDir, name);
    const access = getAgentWorkspaceAccess(workspaceDir);
    let file: FileMeta & { hash: string; content: string };
    if (access) {
      const stat = await access.bridge.stat({ filePath: name });
      if (getAgentWorkspaceAccess(workspaceDir) !== access) {
        throw new Error("Workspace access changed while reading an Agent document");
      }
      if (!stat) {
        respondWorkspaceFileMissing({ respond, agentId, workspaceDir, name, filePath });
        return;
      }
      const data = await access.bridge.readFile({
        filePath: name,
        maxBytes: MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES,
      });
      if (
        getAgentWorkspaceAccess(workspaceDir) !== access ||
        data.length > MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES
      ) {
        throw new Error("Workspace document read is no longer valid");
      }
      file = {
        size: data.length,
        updatedAtMs: Math.floor(stat.mtimeMs),
        hash: hashWorkspaceFileContent(data),
        content: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(data),
      };
    } else {
      let safeRead: ReadResult;
      try {
        const workspaceRoot = await root(workspaceDir);
        safeRead = await workspaceRoot.read(name, {
          hardlinks: "reject",
          nonBlockingRead: true,
        });
      } catch (err) {
        if (isMissingPathError(err)) {
          respondWorkspaceFileMissing({ respond, agentId, workspaceDir, name, filePath });
          return;
        }
        if (err instanceof FsSafeError) {
          respondWorkspaceFileUnsafe(respond, name);
          return;
        }
        throw err;
      }
      file = {
        size: safeRead.stat.size,
        updatedAtMs: Math.floor(safeRead.stat.mtimeMs),
        hash: hashWorkspaceFileContent(safeRead.buffer),
        content: safeRead.buffer.toString("utf-8"),
      };
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
          ...file,
        },
      },
      undefined,
    );
  },
  "agents.files.set": async ({ params, respond, context }) => {
    if (!assertValidParams(params, validateAgentsFilesSetParams, "agents.files.set", respond)) {
      return;
    }
    const resolved = resolveAgentWorkspaceFileOrRespondError(
      params,
      respond,
      context.getRuntimeConfig(),
    );
    if (!resolved) {
      return;
    }
    const { agentId, workspaceDir, name } = resolved;
    const access = getAgentWorkspaceAccess(workspaceDir);
    const filePath = path.join(workspaceDir, name);
    const content = params.content;
    let workspaceRoot: WorkspaceRoot | null = null;
    let conflict: { currentHash: string | undefined } | undefined;
    if (access) {
      if (Buffer.byteLength(params.content) > MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES) {
        throw new Error("Workspace document exceeds its write bound");
      }
      const assertCurrent = () => {
        if (getAgentWorkspaceAccess(workspaceDir) !== access) {
          throw new Error("Workspace access changed while saving an Agent document");
        }
      };
      conflict = await enqueueWorkspaceFileUpdate(async () => {
        assertCurrent();
        const expectedHash = params.expectedHash?.toLowerCase();
        if (expectedHash) {
          const stat = await access.bridge.stat({ filePath: name });
          assertCurrent();
          let currentHash: string | undefined;
          if (stat) {
            const data = await access.bridge.readFile({
              filePath: name,
              maxBytes: MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES,
            });
            assertCurrent();
            if (data.length > MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES) {
              throw new Error("Workspace document exceeds its read bound");
            }
            currentHash = hashWorkspaceFileContent(data);
          }
          if (currentHash !== expectedHash) {
            return { currentHash };
          }
        }
        // Preserve the native editor's best-effort conflict contract. Shell
        // writers remain independent of this Gateway-owned save queue.
        await access.bridge.writeFile({ filePath: name, data: params.content, mkdir: true });
        assertCurrent();
        return undefined;
      });
    } else {
      await fs.mkdir(workspaceDir, { recursive: true });
      try {
        workspaceRoot = await root(workspaceDir);
        const writeRoot = workspaceRoot;
        const expectedHash = params.expectedHash?.toLowerCase();
        conflict = await enqueueWorkspaceFileUpdate(async () => {
          if (expectedHash) {
            const currentHash = await readWorkspaceFileHash(writeRoot, name);
            if (currentHash !== expectedHash) {
              return { currentHash };
            }
          }
          await writeRoot.write(name, content, { encoding: "utf8" });
          return undefined;
        });
      } catch (err) {
        if (!(err instanceof FsSafeError)) {
          throw err;
        }
        respondWorkspaceFileUnsafe(respond, name);
        return;
      }
    }
    if (conflict) {
      respondWorkspaceFileConflict(respond, name, conflict.currentHash);
      return;
    }
    const meta: Partial<FileMeta> | null = access
      ? { size: Buffer.byteLength(content) }
      : await statWorkspaceFileSafely(workspaceRoot, workspaceDir, name);
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
          ...(!access ? { updatedAtMs: meta?.updatedAtMs } : {}),
          hash: hashWorkspaceFileContent(content),
          content,
        },
      },
      undefined,
    );
  },
};

import fs from "node:fs/promises";
import path from "node:path";
import { sha256Hex } from "@openclaw/normalization-core/node-crypto";
import {
  type AgentsFilesGetParams,
  type AgentsFilesGetResult,
  ErrorCodes,
  errorShape,
  validateAgentsFilesGetParams,
  validateAgentsFilesListParams,
  validateAgentsFilesSetParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { resolveAgentWorkspaceDir } from "../../agents/agent-scope.js";
import { buildIdentityMarkdownForWrite } from "../../agents/identity-file.js";
import { getAgentWorkspaceAccess } from "../../agents/workspace-access.js";
import { MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES } from "../../agents/workspace-bootstrap-read.js";
import {
  DEFAULT_BOOTSTRAP_FILENAME,
  DEFAULT_IDENTITY_FILENAME,
  isExpectedAbsentBootstrapFile,
  isWorkspaceSetupCompleted,
  WORKSPACE_BOOTSTRAP_FILENAMES,
} from "../../agents/workspace.js";
import type { IdentityConfig } from "../../config/types.base.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { isMissingPathError } from "../../infra/errors.js";
import { root, FsSafeError, type ReadResult } from "../../infra/fs-safe.js";
import { resolveConfiguredAgentIdOrRespondError } from "./agent-id-shared.js";
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

function resolveAgentWorkspaceFileOrRespondError(
  params: AgentsFilesGetParams,
  respond: RespondFn,
  cfg: OpenClawConfig,
): {
  agentId: string;
  workspaceDir: string;
  name: string;
} | null {
  const agentId = resolveConfiguredAgentIdOrRespondError(params.agentId, cfg, respond);
  if (!agentId) {
    return null;
  }
  const name = params.name.trim();
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

async function statWorkspaceFileSafely(
  workspaceRoot: WorkspaceRoot | null,
  name: string,
): Promise<FileMeta | null> {
  try {
    const stat = await workspaceRoot?.stat(name);
    return stat?.isFile && !stat.isSymbolicLink && stat.nlink <= 1
      ? { size: stat.size, updatedAtMs: Math.floor(stat.mtimeMs) }
      : null;
  } catch {
    return null;
  }
}

function respondWorkspaceFileUnsafe(respond: RespondFn, name: string): void {
  respond(
    false,
    undefined,
    errorShape(ErrorCodes.INVALID_REQUEST, `unsafe workspace file "${name}"`),
  );
}

export async function writeWorkspaceFileOrRespond(params: {
  respond: RespondFn;
  workspaceDir: string;
  name: string;
  content: string;
  assertCurrent?: () => void;
}): Promise<boolean> {
  const access = getAgentWorkspaceAccess(params.workspaceDir);
  if (access) {
    if (Buffer.byteLength(params.content) > MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES) {
      throw new Error("Workspace document exceeds its write bound");
    }
    params.assertCurrent?.();
    await access.bridge.writeFile({ filePath: params.name, data: params.content, mkdir: false });
    if (getAgentWorkspaceAccess(params.workspaceDir) !== access) {
      throw new Error("Workspace access changed while saving Agent identity");
    }
    return true;
  }
  params.assertCurrent?.();
  await fs.mkdir(params.workspaceDir, { recursive: true });
  try {
    const workspaceRoot = await root(params.workspaceDir);
    await workspaceRoot.write(params.name, params.content, {
      encoding: "utf8",
      assertBeforeMutation: params.assertCurrent,
    });
  } catch (err) {
    if (err instanceof FsSafeError) {
      respondWorkspaceFileUnsafe(params.respond, params.name);
      return false;
    }
    throw err;
  }
  return true;
}

async function readWorkspaceFileContent(
  workspaceDir: string,
  name: string,
): Promise<string | undefined> {
  try {
    const access = getAgentWorkspaceAccess(workspaceDir);
    if (access) {
      const data = await access.bridge.readFile({
        filePath: name,
        maxBytes: MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES,
      });
      if (getAgentWorkspaceAccess(workspaceDir) !== access) {
        throw new Error("Workspace access changed while reading Agent identity");
      }
      if (data.length > MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES) {
        throw new Error("Workspace document exceeds its read bound");
      }
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(data);
    }
    const workspaceRoot = await root(workspaceDir);
    const safeRead = await workspaceRoot.read(name, {
      hardlinks: "reject",
    });
    return safeRead.buffer.toString("utf-8");
  } catch (err) {
    if (isMissingPathError(err)) {
      return undefined;
    }
    throw err;
  }
}

export async function buildIdentityMarkdownOrRespondUnsafe(params: {
  respond: RespondFn;
  workspaceDir: string;
  identity: IdentityConfig;
  fallbackWorkspaceDir?: string;
  preferFallbackWorkspaceContent?: boolean;
}): Promise<string | null> {
  try {
    return await buildIdentityMarkdownForWrite({ ...params, readWorkspaceFileContent });
  } catch (err) {
    if (err instanceof FsSafeError) {
      respondWorkspaceFileUnsafe(params.respond, DEFAULT_IDENTITY_FILENAME);
      return null;
    }
    throw err;
  }
}

async function readWorkspaceFileHash(
  workspaceRoot: WorkspaceRoot,
  name: string,
): Promise<string | undefined> {
  try {
    const safeRead = await workspaceRoot.read(name, {
      hardlinks: "reject",
    });
    return sha256Hex(safeRead.buffer);
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
    const agentId = resolveConfiguredAgentIdOrRespondError(params.agentId, cfg, respond);
    if (!agentId) {
      return;
    }
    const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
    let hideBootstrap = false;
    try {
      hideBootstrap = await isWorkspaceSetupCompleted(workspaceDir);
    } catch {
      // Fall back to showing BOOTSTRAP if workspace state cannot be read.
    }
    const access = getAgentWorkspaceAccess(workspaceDir);
    const workspaceRoot = access ? null : await root(workspaceDir).catch(() => null);
    const names = hideBootstrap ? CORE_FILE_NAMES_POST_ONBOARDING : CORE_FILE_NAMES;
    const files = await Promise.all(
      names.map(async (name) => {
        let meta: FileMeta | null;
        if (access) {
          const stat = await access.bridge.stat({ filePath: name });
          if (getAgentWorkspaceAccess(workspaceDir) !== access) {
            throw new Error("Workspace access changed while listing Agent documents");
          }
          meta =
            stat?.type === "file"
              ? { size: stat.size, updatedAtMs: Math.floor(stat.mtimeMs) }
              : null;
        } else {
          meta = await statWorkspaceFileSafely(workspaceRoot, name);
        }
        return Object.assign(
          {
            name,
            path: path.join(workspaceDir, name),
            missing: meta === null,
          },
          meta ?? { expectedAbsent: isExpectedAbsentBootstrapFile(name) },
        );
      }),
    );
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
    const respondFile = (file?: Omit<AgentsFilesGetResult["file"], "name" | "path" | "missing">) =>
      respond(
        true,
        {
          agentId,
          workspace: workspaceDir,
          file: {
            name,
            path: filePath,
            missing: file === undefined,
            // Missing entries retain the same absence classification as the file list.
            ...(file ?? { expectedAbsent: isExpectedAbsentBootstrapFile(name) }),
          },
        },
        undefined,
      );
    const access = getAgentWorkspaceAccess(workspaceDir);
    let file: FileMeta & { hash: string; content: string };
    if (access) {
      const stat = await access.bridge.stat({ filePath: name });
      if (getAgentWorkspaceAccess(workspaceDir) !== access) {
        throw new Error("Workspace access changed while reading an Agent document");
      }
      if (!stat) {
        respondFile();
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
        hash: sha256Hex(data),
        content: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(data),
      };
    } else {
      let safeRead: ReadResult;
      try {
        const workspaceRoot = await root(workspaceDir);
        safeRead = await workspaceRoot.read(name, {
          hardlinks: "reject",
        });
      } catch (err) {
        if (isMissingPathError(err)) {
          respondFile();
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
        hash: sha256Hex(safeRead.buffer),
        content: safeRead.buffer.toString("utf-8"),
      };
    }
    respondFile(file);
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
      const createFileExclusive = access.bridge.createFileExclusive;
      if (params.expectedMissing && !createFileExclusive) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            "This workspace host cannot safely create a missing Agent document. Update its workspace provider, or create the file on that host and reload it before saving.",
          ),
        );
        return;
      }
      conflict = await enqueueWorkspaceFileUpdate(async () => {
        assertCurrent();
        if (params.expectedMissing && createFileExclusive) {
          const result = await createFileExclusive({
            filePath: name,
            data: content,
            mkdir: true,
          });
          assertCurrent();
          return result === "exists" ? { currentHash: undefined } : undefined;
        }
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
            currentHash = sha256Hex(data);
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
          if (params.expectedMissing) {
            try {
              await writeRoot.create(name, content, { encoding: "utf8", atomic: true });
            } catch (err) {
              if (err instanceof FsSafeError && err.code === "already-exists") {
                return { currentHash: undefined };
              }
              throw err;
            }
            return undefined;
          }
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
      : await statWorkspaceFileSafely(workspaceRoot, name);
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
          hash: sha256Hex(content),
          content,
        },
      },
      undefined,
    );
  },
};

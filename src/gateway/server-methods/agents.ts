// Agents gateway methods expose agent listing, config mutation, workspace file
// reads/writes, identity merging, and safe deletion for operator clients.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { normalizeOptionalString as resolveOptionalStringParam } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  validateAgentsCreateParams,
  validateAgentsDeleteParams,
  validateAgentsUpdateParams,
} from "../../../packages/gateway-protocol/src/index.js";
import type { AgentsDeleteResult } from "../../../packages/gateway-protocol/src/schema/agents-models-skills.js";
import { createAgent } from "../../agents/agent-create.js";
import {
  AgentSharedStoreOwnerError,
  assertAgentSessionStoreDeletionSafe,
  isPathOwnedBySurvivingAgent,
  prepareAgentDeleteDatabases,
  readAgentDeleteDatabaseRegistry,
  resolveSurvivingDatabaseFilePaths,
  type AgentDeleteDatabasePlan,
} from "../../agents/agent-delete-databases.js";
import {
  formatSharedAuthStoreOwnerDeleteError,
  isInheritedAuthStoreOwner,
  isSharedAuthStoreOwner,
} from "../../agents/agent-delete-safety.js";
import {
  normalizeAgentDirRegistryPath,
  registerResolvedAgentDir,
  resolveRegisteredAgentIdForDir,
  unregisterResolvedAgentDir,
} from "../../agents/agent-dir-registry.js";
import {
  AgentDeletionAuthorityRollbackError,
  AgentDeletionCommitUncertainError,
  withAgentDeletion,
  claimCompletedAgentDeletion,
} from "../../agents/agent-lifecycle-registry.js";
import {
  listAgentIds,
  resolveAgentDir,
  resolveAgentWorkspaceDir,
  tryResolveSoleAgentId,
} from "../../agents/agent-scope.js";
import {
  resolveSharedAuthStoreOwnership,
  resolveSharedAuthStorePath,
} from "../../agents/auth-profiles/path-resolve.js";
import { resolveAuthProfileDatabasePath } from "../../agents/auth-profiles/sqlite.js";
import {
  buildIdentityMarkdownForWrite,
  createAgentIdentityConfig,
  normalizeIdentityForFile,
  sanitizeAgentIdentityLine,
} from "../../agents/identity-file.js";
import { resolveAgentIdentity } from "../../agents/identity.js";
import { getAgentWorkspaceAccess } from "../../agents/workspace-access.js";
import { MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES } from "../../agents/workspace-bootstrap-read.js";
import {
  prepareLegacyWorkspaceStateReset,
  removeLegacyWorkspaceStateForReset,
} from "../../agents/workspace-legacy-state.js";
import {
  deleteWorkspaceState,
  prepareWorkspaceStateDeletion,
} from "../../agents/workspace-state-store.js";
import { DEFAULT_IDENTITY_FILENAME, ensureAgentWorkspace } from "../../agents/workspace.js";
import { applyAgentConfig } from "../../commands/agents.config.js";
import { trashAllowedRoots } from "../../commands/cleanup-utils.js";
import {
  readConfigFileSnapshotForWrite,
  withConfigMutationExclusive,
} from "../../config/config.js";
import { purgeAgentSessionStoreEntries } from "../../config/sessions.js";
import { resolveSessionTranscriptsDirForAgent } from "../../config/sessions/paths.js";
import type { IdentityConfig } from "../../config/types.base.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { isMissingPathError } from "../../infra/errors.js";
import { withAgentExecApprovalsRemoved } from "../../infra/exec-approvals.js";
import { root, FsSafeError } from "../../infra/fs-safe.js";
import { isPathInside } from "../../infra/path-guards.js";
import { movePathToTrash } from "../../plugin-sdk/browser-maintenance.js";
import { normalizeAgentIdStrict } from "../../routing/session-key.js";
import {
  readAgentDeletionJournal,
  type AgentDeletionJournalCleanupPath,
} from "../../state/agent-deletion-journal.js";
import { unregisterOpenClawAgentDatabase } from "../../state/openclaw-agent-db-registry.js";
import { resolveUserPath } from "../../utils.js";
import {
  AgentConfigPreconditionError,
  AgentModelSelectionError,
  deleteAgentConfigEntry,
  isConfiguredAgent,
  isImplicitAgentModelUpdate,
  updateAgentConfigEntry,
  validateAgentModelSelectionUpdate,
} from "./agents-config-mutations.js";
import { agentFileHandlers } from "./agents-files.js";
import { agentListHandler } from "./agents-list.js";
import type { GatewayRequestHandlers, RespondFn } from "./types.js";
import { assertValidParams } from "./validation.js";

function respondAgentNotFound(respond: RespondFn, agentId: string): void {
  respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, `agent "${agentId}" not found`));
}

type AgentDeleteRemovedPath = NonNullable<AgentsDeleteResult["removed"]>[number];
type AgentDeleteFailedPath = NonNullable<AgentsDeleteResult["failed"]>[number];

type AgentDeletePathOutcome =
  | { removed: AgentDeleteRemovedPath }
  | { skipped: AgentDeleteFailedPath }
  | { failed: AgentDeleteFailedPath };

class AgentCleanupIdentityMismatchError extends Error {}
class AgentSharedAuthStoreOwnerError extends Error {}

function agentOwnsSharedAuthStore(cfg: OpenClawConfig, agentId: string): boolean {
  const agentDir = resolveAgentDir(cfg, agentId);
  return isSharedAuthStoreOwner({
    ownership: resolveSharedAuthStoreOwnership(),
    agentAuthDbPath: resolveAuthProfileDatabasePath(agentDir),
    sharedAuthDbPath: resolveSharedAuthStorePath(),
  });
}

function cleanupFailure(pathname: string, error: unknown): AgentDeletePathOutcome {
  const reason = error instanceof Error && error.message ? error.message : String(error);
  return { failed: { path: pathname, reason: reason || "unknown error" } };
}

function cleanupPathIdentity(stat: { dev?: number | bigint; ino?: number | bigint } | undefined) {
  if (
    (typeof stat?.dev !== "number" && typeof stat?.dev !== "bigint") ||
    (typeof stat.ino !== "number" && typeof stat.ino !== "bigint")
  ) {
    return null;
  }
  const dev = Number(stat.dev);
  const ino = Number(stat.ino);
  if (!Number.isSafeInteger(dev) || !Number.isSafeInteger(ino)) {
    throw new Error("cleanup path identity exceeds the safe integer range");
  }
  return { dev, ino };
}

async function statAgentCleanupPath(cleanupPath: AgentDeleteCleanupPath) {
  const parentPath = cleanupPath.parentPath;
  const parentRoot = await root(parentPath, {
    hardlinks: "reject",
    symlinks: "reject",
  });
  if (path.resolve(parentRoot.rootReal) !== parentPath) {
    throw new FsSafeError("path-mismatch", "cleanup path parent changed before deletion");
  }
  const stat = await parentRoot.stat(path.basename(cleanupPath.trashPath));
  const isSymlink = stat.isSymbolicLink;
  if (isSymlink !== (cleanupPath.kind === "symlink")) {
    throw new AgentCleanupIdentityMismatchError(
      `cleanup path changed from ${cleanupPath.kind} before deletion`,
    );
  }
  if (stat.isFile && stat.nlink > 1) {
    throw new AgentCleanupIdentityMismatchError("hardlinked cleanup replacement preserved");
  }
  const identity = cleanupPathIdentity(stat);
  if (cleanupPath.preparedIdentity === null) {
    // The journal fence blocks legitimate claims on prepared-absent paths, so a
    // file that appeared here is leaked deleted-agent state (recreated WAL
    // sidecars, runtime home rewrites). Adopt it and sweep it; preserving it
    // cascades ancestor protection and finishes over a surviving tree.
    cleanupPath.preparedIdentity = identity;
  } else if (
    identity === null ||
    identity.dev !== cleanupPath.preparedIdentity.dev ||
    identity.ino !== cleanupPath.preparedIdentity.ino
  ) {
    throw new AgentCleanupIdentityMismatchError("cleanup path identity changed before deletion");
  }
}

async function removeAgentPath(
  cleanupPath: AgentDeleteCleanupPath,
  assertCurrent: () => void,
): Promise<AgentDeletePathOutcome> {
  const pathname = cleanupPath.path;
  const trashPath = cleanupPath.trashPath;
  try {
    await statAgentCleanupPath(cleanupPath);
  } catch (error) {
    if (error instanceof AgentCleanupIdentityMismatchError) {
      return { skipped: { path: pathname, reason: error.message } };
    }
    return isMissingPathError(error)
      ? { removed: { path: pathname, method: "missing" } }
      : cleanupFailure(pathname, error);
  }
  try {
    // fs-safe pins traversal and identity for validation; Trash has no fd-relative move API, so
    // replacement after this check and before its rename is the accepted residual race bound.
    assertCurrent();
    // statAgentCleanupPath verified the declared parent; fs-safe's default roots (home/tmp)
    // alone refuse every path of a volume-backed state dir. Keep those defaults so the
    // directory behind a workspace symlink stays fenced exactly as shipped, while the link
    // itself may always move (accepted edge: a link target beside its link is trashed too).
    await movePathToTrash(trashPath, {
      allowedRoots: [
        ...trashAllowedRoots(
          cleanupPath.sourcePaths,
          cleanupPath.kind === "symlink" ? cleanupPath.canonicalPath : undefined,
        ),
        os.homedir(),
        os.tmpdir(),
      ],
    });
    return { removed: { path: pathname, method: "trash" } };
  } catch (error) {
    if (!isMissingPathError(error)) {
      return cleanupFailure(pathname, error);
    }
    try {
      await statAgentCleanupPath(cleanupPath);
      return cleanupFailure(pathname, error);
    } catch (statError) {
      return isMissingPathError(statError)
        ? { removed: { path: pathname, method: "missing" } }
        : cleanupFailure(pathname, statError);
    }
  }
}

type AgentDeleteCleanupPath = {
  path: string;
  parentPath: string;
  canonicalPath: string;
  trashPath: string;
  trashCoversDescendants: boolean;
  kind: "target" | "symlink";
  preparedIdentity: { dev: number; ino: number } | null;
  done: boolean;
  note?: string;
  preparationError?: unknown;
  sourcePaths: string[];
};

async function resolveAgentDeleteCleanupTarget(pathname: string): Promise<string> {
  let candidate = path.resolve(pathname);
  const missingSuffix: string[] = [];
  while (true) {
    try {
      return path.resolve(await fs.realpath(candidate), ...missingSuffix);
    } catch (error) {
      if (!isMissingPathError(error)) {
        throw error;
      }
      let candidateStat: Awaited<ReturnType<typeof fs.lstat>> | undefined;
      try {
        candidateStat = await fs.lstat(candidate);
      } catch (statError) {
        if (!isMissingPathError(statError)) {
          throw statError;
        }
      }
      if (candidateStat?.isSymbolicLink()) {
        const linkTarget = await fs.readlink(candidate);
        const resolvedLinkTarget = await resolveAgentDeleteCleanupTarget(
          path.isAbsolute(linkTarget)
            ? linkTarget
            : path.resolve(path.dirname(candidate), linkTarget),
        );
        return path.resolve(resolvedLinkTarget, ...missingSuffix);
      }
      const parent = path.dirname(candidate);
      if (parent === candidate) {
        throw error;
      }
      missingSuffix.unshift(path.basename(candidate));
      candidate = parent;
    }
  }
}

async function prepareAgentDeleteCleanupPaths(
  paths: readonly string[],
  persistedPaths: readonly AgentDeletionJournalCleanupPath[] = [],
): Promise<AgentDeleteCleanupPath[]> {
  const uniquePaths = new Map<string, AgentDeleteCleanupPath>();
  const addPath = (candidate: AgentDeleteCleanupPath) => {
    const existing = uniquePaths.get(candidate.trashPath);
    if (!existing) {
      uniquePaths.set(candidate.trashPath, candidate);
      return;
    }
    existing.sourcePaths = [...new Set([...existing.sourcePaths, ...candidate.sourcePaths])];
    existing.done ||= candidate.done;
    existing.note ??= candidate.note;
    existing.preparationError ??= candidate.preparationError;
    if (candidate.kind === "target") {
      existing.kind = "target";
      existing.canonicalPath = candidate.canonicalPath;
      existing.parentPath = candidate.parentPath;
      existing.trashCoversDescendants ||= candidate.trashCoversDescendants;
    }
  };
  if (persistedPaths.length > 0) {
    for (const persistedPath of persistedPaths) {
      const journalPath = path.resolve(persistedPath.path);
      const trashPath = path.resolve(persistedPath.canonicalPath);
      addPath({
        path: journalPath,
        parentPath: path.resolve(persistedPath.parentPath),
        canonicalPath: normalizeAgentDirRegistryPath(trashPath),
        trashPath,
        trashCoversDescendants: persistedPath.coversDescendants,
        kind: persistedPath.kind,
        preparedIdentity:
          persistedPath.dev === null || persistedPath.ino === null
            ? null
            : { dev: persistedPath.dev, ino: persistedPath.ino },
        done: persistedPath.done,
        note: persistedPath.note,
        sourcePaths: persistedPath.sourcePaths.map((sourcePath) => path.resolve(sourcePath)),
      });
    }
  }
  for (const pathname of paths) {
    const sourcePath = path.resolve(pathname);
    let sourceParentPath = path.dirname(sourcePath);
    let resolvedPath = sourcePath;
    let preparationError: unknown;
    try {
      resolvedPath = await resolveAgentDeleteCleanupTarget(pathname);
      sourceParentPath = await resolveAgentDeleteCleanupTarget(path.dirname(sourcePath));
    } catch (error) {
      preparationError = error;
    }
    let sourceStat: Awaited<ReturnType<typeof fs.lstat>> | undefined;
    try {
      sourceStat = await fs.lstat(pathname);
    } catch (error) {
      if (!isMissingPathError(error)) {
        preparationError ??= error;
      }
    }
    let targetStat = sourceStat;
    if (resolvedPath !== sourcePath) {
      try {
        targetStat = await fs.lstat(resolvedPath);
      } catch (error) {
        if (!isMissingPathError(error)) {
          preparationError ??= error;
        }
        targetStat = undefined;
      }
    }
    const canonicalPath = normalizeAgentDirRegistryPath(resolvedPath);
    let trashCoversDescendants = false;
    if (targetStat) {
      trashCoversDescendants = !targetStat.isSymbolicLink();
    }
    addPath({
      path: resolvedPath,
      parentPath: path.dirname(resolvedPath),
      canonicalPath,
      trashPath: resolvedPath,
      trashCoversDescendants,
      kind: "target",
      preparedIdentity: cleanupPathIdentity(targetStat),
      done: false,
      preparationError,
      sourcePaths: [sourcePath],
    });
    if (sourceStat?.isSymbolicLink() && sourcePath !== resolvedPath) {
      addPath({
        path: sourcePath,
        parentPath: sourceParentPath,
        canonicalPath,
        trashPath: path.join(sourceParentPath, path.basename(sourcePath)),
        trashCoversDescendants: false,
        kind: "symlink",
        preparedIdentity: cleanupPathIdentity(sourceStat),
        done: false,
        sourcePaths: [sourcePath],
      });
    }
  }
  const depth = (pathname: string) =>
    path.relative(path.parse(pathname).root, pathname).split(path.sep).filter(Boolean).length;
  const cleanupDepth = (cleanupPath: AgentDeleteCleanupPath) =>
    Math.max(
      depth(cleanupPath.canonicalPath),
      depth(cleanupPath.trashPath),
      ...cleanupPath.sourcePaths.map(depth),
    );
  const compareFallback = (left: AgentDeleteCleanupPath, right: AgentDeleteCleanupPath) => {
    if (left.kind !== right.kind) {
      return left.kind === "target" ? -1 : 1;
    }
    const depthDifference = cleanupDepth(right) - cleanupDepth(left);
    if (depthDifference !== 0) {
      return depthDifference;
    }
    const trashDepth = depth(right.trashPath) - depth(left.trashPath);
    return trashDepth || left.trashPath.localeCompare(right.trashPath);
  };
  const mustPrecede = (left: AgentDeleteCleanupPath, right: AgentDeleteCleanupPath) => {
    if (left.kind !== right.kind) {
      return left.kind === "target";
    }
    if (isPathInside(right.trashPath, left.trashPath)) {
      return true;
    }
    if (isPathInside(left.trashPath, right.trashPath)) {
      return false;
    }
    const rightRoots = [right.trashPath, ...right.sourcePaths];
    return left.sourcePaths.some((leftSource) =>
      rightRoots.some((rightRoot) => isPathInside(rightRoot, leftSource)),
    );
  };
  const remaining = [...uniquePaths.values()].toSorted(compareFallback);
  const ordered: AgentDeleteCleanupPath[] = [];
  // Snapshot real targets and clean every physical or lexical descendant first; moving an
  // ancestor symlink would otherwise hide surviving child data and let recovery finalize.
  while (remaining.length > 0) {
    const nextIndex = remaining.findIndex((candidate, candidateIndex) =>
      remaining.every(
        (other, otherIndex) => otherIndex === candidateIndex || !mustPrecede(other, candidate),
      ),
    );
    ordered.push(...remaining.splice(Math.max(0, nextIndex), 1));
  }
  return ordered;
}

function cleanupPathCovers(
  cleanupPath: AgentDeleteCleanupPath,
  targetPath: string,
  canonicalTargetPath: string,
): boolean {
  const trashTargetPath = path.resolve(targetPath);
  return (
    cleanupPath.sourcePaths.includes(trashTargetPath) ||
    cleanupPath.trashPath === trashTargetPath ||
    (cleanupPath.trashCoversDescendants &&
      (cleanupPath.kind === "target" || isPathInside(cleanupPath.trashPath, trashTargetPath)) &&
      isPathInside(cleanupPath.canonicalPath, canonicalTargetPath))
  );
}

function unregisterAgentDeleteDatabases(agentId: string, databasePaths: string[]): void {
  for (const databasePath of databasePaths) {
    unregisterOpenClawAgentDatabase({ agentId, path: databasePath });
  }
}

function prepareJournaledAgentDirOwnership(
  cfg: OpenClawConfig,
  agentId: string,
  agentDir: string,
): void {
  for (const configuredAgentId of listAgentIds(cfg)) {
    resolveAgentDir(cfg, configuredAgentId);
  }
  const registeredOwner = resolveRegisteredAgentIdForDir(agentDir);
  if (registeredOwner !== undefined) {
    return;
  }
  // The durable journal retains ownership across restarts after the roster entry is gone.
  registerResolvedAgentDir({ agentId, agentDir });
}

function respondWorkspaceFileUnsafe(respond: RespondFn, name: string): void {
  respond(
    false,
    undefined,
    errorShape(ErrorCodes.INVALID_REQUEST, `unsafe workspace file "${name}"`),
  );
}

async function writeWorkspaceFileOrRespond(params: {
  respond: RespondFn;
  workspaceDir: string;
  name: string;
  content: string;
}): Promise<boolean> {
  const access = getAgentWorkspaceAccess(params.workspaceDir);
  if (access) {
    if (Buffer.byteLength(params.content) > MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES) {
      throw new Error("Workspace document exceeds its write bound");
    }
    await access.bridge.writeFile({ filePath: params.name, data: params.content, mkdir: false });
    if (getAgentWorkspaceAccess(params.workspaceDir) !== access) {
      throw new Error("Workspace access changed while saving Agent identity");
    }
    return true;
  }
  await fs.mkdir(params.workspaceDir, { recursive: true });
  try {
    const workspaceRoot = await root(params.workspaceDir);
    await workspaceRoot.write(params.name, params.content, { encoding: "utf8" });
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
      nonBlockingRead: true,
    });
    return safeRead.buffer.toString("utf-8");
  } catch (err) {
    if (isMissingPathError(err)) {
      return undefined;
    }
    throw err;
  }
}

async function buildIdentityMarkdownOrRespondUnsafe(params: {
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

export const agentsHandlers: GatewayRequestHandlers = {
  "agents.list": agentListHandler,
  "agents.create": async ({ params, respond }) => {
    if (!assertValidParams(params, validateAgentsCreateParams, "agents.create", respond)) {
      return;
    }

    const result = await createAgent({
      name: params.name,
      workspace: params.workspace,
      model: params.model,
      emoji: params.emoji,
      avatar: params.avatar,
    });
    if (result.status === "error") {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, result.message));
      return;
    }
    respond(
      true,
      {
        ok: true,
        agentId: result.agentId,
        name: result.name,
        workspace: result.workspace,
        ...(result.model ? { model: result.model } : {}),
      },
      undefined,
    );
  },
  "agents.update": async ({ params, respond, context }) => {
    if (!assertValidParams(params, validateAgentsUpdateParams, "agents.update", respond)) {
      return;
    }

    const cfg = context.getRuntimeConfig();
    const normalized = normalizeAgentIdStrict(params.agentId);
    if (!normalized.ok) {
      respondAgentNotFound(respond, params.agentId);
      return;
    }
    const agentId = normalized.value;
    const workspaceDir =
      typeof params.workspace === "string" && params.workspace.trim()
        ? resolveUserPath(params.workspace.trim())
        : undefined;

    const model = params.model === null ? null : resolveOptionalStringParam(params.model);

    const safeName =
      typeof params.name === "string" && params.name.trim()
        ? sanitizeAgentIdentityLine(params.name.trim())
        : undefined;

    const identity = createAgentIdentityConfig({
      name: safeName,
      emoji: params.emoji,
      avatar: params.avatar,
    });
    const hasIdentityFields = Boolean(identity);

    const agentConfigUpdate: Parameters<typeof updateAgentConfigEntry>[0] = {
      agentId,
      ...(safeName ? { name: safeName } : {}),
      ...(workspaceDir ? { workspace: workspaceDir } : {}),
      ...(model !== undefined ? { model } : {}),
      ...(params.agentRuntime ? { agentRuntime: params.agentRuntime } : {}),
      ...(identity ? { identity } : {}),
    };
    const selectionError = validateAgentModelSelectionUpdate(params);
    if (selectionError) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, selectionError));
      return;
    }
    const configured = isConfiguredAgent(cfg, agentId);
    if (!configured && !isImplicitAgentModelUpdate(cfg, agentConfigUpdate)) {
      respondAgentNotFound(respond, agentId);
      return;
    }
    const nextConfig = configured ? applyAgentConfig(cfg, agentConfigUpdate) : cfg;

    let ensuredWorkspace: Awaited<ReturnType<typeof ensureAgentWorkspace>> | undefined;
    if (workspaceDir) {
      const skipBootstrap = Boolean(nextConfig.agents?.defaults?.skipBootstrap);
      ensuredWorkspace = await ensureAgentWorkspace({
        dir: workspaceDir,
        ensureBootstrapFiles: !skipBootstrap,
        skipOptionalBootstrapFiles: nextConfig.agents?.defaults?.skipOptionalBootstrapFiles,
      });
    }

    const persistedIdentity = normalizeIdentityForFile(resolveAgentIdentity(nextConfig, agentId));
    if (persistedIdentity && (workspaceDir || hasIdentityFields)) {
      const identityWorkspaceDir = resolveAgentWorkspaceDir(nextConfig, agentId);
      const previousWorkspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
      const fallbackWorkspaceDir =
        workspaceDir && identityWorkspaceDir !== previousWorkspaceDir
          ? previousWorkspaceDir
          : undefined;
      // A workspace service may be replaced while the identity read is awaiting I/O.
      // Keep both the source and destination pinned for this read/merge/write.
      const workspaceAccess = [
        identityWorkspaceDir,
        ...(fallbackWorkspaceDir ? [fallbackWorkspaceDir] : []),
      ].map((dir) => [dir, getAgentWorkspaceAccess(dir)] as const);
      const assertWorkspaceAccessCurrent = () => {
        for (const [dir, access] of workspaceAccess) {
          if (getAgentWorkspaceAccess(dir) !== access) {
            throw new Error("Workspace access changed while updating Agent identity");
          }
        }
      };
      const identityContent = await buildIdentityMarkdownOrRespondUnsafe({
        respond,
        workspaceDir: identityWorkspaceDir,
        identity: persistedIdentity,
        fallbackWorkspaceDir,
        preferFallbackWorkspaceContent:
          Boolean(fallbackWorkspaceDir) && ensuredWorkspace?.identityPathCreated === true,
      });
      if (identityContent === null) {
        return;
      }
      assertWorkspaceAccessCurrent();
      if (
        !(await writeWorkspaceFileOrRespond({
          respond,
          workspaceDir: identityWorkspaceDir,
          name: DEFAULT_IDENTITY_FILENAME,
          content: identityContent,
        }))
      ) {
        return;
      }
      assertWorkspaceAccessCurrent();
    }

    try {
      await updateAgentConfigEntry(agentConfigUpdate);
    } catch (error) {
      if (error instanceof AgentConfigPreconditionError) {
        respondAgentNotFound(respond, agentId);
        return;
      }
      if (error instanceof AgentModelSelectionError) {
        respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, error.message));
        return;
      }
      throw error;
    }

    respond(true, { ok: true, agentId }, undefined);
  },
  "agents.delete": async ({ params, respond, context }) => {
    if (!assertValidParams(params, validateAgentsDeleteParams, "agents.delete", respond)) {
      return;
    }

    const cfg = context.getRuntimeConfig();
    const normalized = normalizeAgentIdStrict(params.agentId);
    if (!normalized.ok) {
      respondAgentNotFound(respond, params.agentId);
      return;
    }
    const agentId = normalized.value;
    if (agentOwnsSharedAuthStore(cfg, agentId)) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, formatSharedAuthStoreOwnerDeleteError(agentId)),
      );
      return;
    }
    const existingJournal = readAgentDeletionJournal(agentId);
    if (
      !isConfiguredAgent(cfg, agentId) &&
      (!existingJournal || existingJournal.cleanupCompleted)
    ) {
      respondAgentNotFound(respond, agentId);
      return;
    }
    if (agentId === tryResolveSoleAgentId(cfg)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `Agent "${agentId}" is the only configured agent and cannot be deleted.`,
        ),
      );
      return;
    }
    if (isInheritedAuthStoreOwner(cfg, agentId)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `Agent "${agentId}" owns inherited credentials through agents.defaults.authInheritance.agentId and cannot be deleted. Relocate those credentials, then re-point or remove that binding before retrying.`,
        ),
      );
      return;
    }

    const requestedDeleteFiles =
      typeof params.deleteFiles === "boolean" ? params.deleteFiles : true;
    try {
      const result = await withAgentDeletion(agentId, async (begin) =>
        withConfigMutationExclusive(async (lockedConfig) => {
          assertAgentSessionStoreDeletionSafe(lockedConfig, agentId);
          let lockedJournal = readAgentDeletionJournal(agentId);
          const configured = isConfiguredAgent(lockedConfig, agentId);
          if (agentOwnsSharedAuthStore(lockedConfig, agentId)) {
            throw new AgentSharedAuthStoreOwnerError(
              formatSharedAuthStoreOwnerDeleteError(agentId),
            );
          }
          if (!configured && (!lockedJournal || lockedJournal.cleanupCompleted)) {
            throw new AgentConfigPreconditionError(`agent "${agentId}" not found`);
          }
          if (agentId === tryResolveSoleAgentId(lockedConfig)) {
            throw new AgentConfigPreconditionError(
              `agent "${agentId}" is the only configured agent`,
            );
          }
          if (isInheritedAuthStoreOwner(lockedConfig, agentId)) {
            throw new AgentConfigPreconditionError(
              `agent "${agentId}" owns agents.defaults.authInheritance.agentId; relocate credentials and re-point it first`,
            );
          }
          if (configured && lockedJournal?.cleanupCompleted) {
            const claimed = claimCompletedAgentDeletion(agentId, lockedJournal.operationId);
            const remainingJournal = readAgentDeletionJournal(agentId);
            if (!claimed && remainingJournal) {
              throw new Error(
                `agent "${agentId}" deletion tombstone changed before fresh deletion`,
              );
            }
            lockedJournal = undefined;
          }
          const deleteFiles = lockedJournal?.deleteFiles ?? requestedDeleteFiles;
          const deletion = begin(
            lockedJournal ?? {
              agentId,
              agentDir: resolveAgentDir(lockedConfig, agentId),
              workspaceDir: resolveAgentWorkspaceDir(lockedConfig, agentId),
              sessionsDir: resolveSessionTranscriptsDirForAgent(agentId),
              deleteFiles,
            },
          );
          const journal = deletion.entry;
          let rosterCommitted = !configured;
          let committed: Awaited<ReturnType<typeof deleteAgentConfigEntry>> | undefined;
          let databasePlan: AgentDeleteDatabasePlan | undefined;
          try {
            prepareJournaledAgentDirOwnership(lockedConfig, agentId, journal.agentDir);
            databasePlan = await prepareAgentDeleteDatabases(
              lockedConfig,
              agentId,
              journal.agentDir,
            );
            deletion.assertCurrent();
            deletion.fenceDatabasePaths([
              ...journal.databasePaths,
              ...databasePlan.fileGroups.flat(),
            ]);
            if (deleteFiles) {
              const fencedSourcePaths = new Set(
                journal.cleanupPaths.flatMap((cleanupPath) =>
                  cleanupPath.sourcePaths.map((sourcePath) => path.resolve(sourcePath)),
                ),
              );
              const unfencedSourcePaths = [
                journal.workspaceDir,
                journal.agentDir,
                journal.sessionsDir,
                ...journal.databasePaths,
              ].filter((sourcePath) => !fencedSourcePaths.has(path.resolve(sourcePath)));
              if (unfencedSourcePaths.length > 0) {
                const unfencedSourcePathSet = new Set(
                  unfencedSourcePaths.map((sourcePath) => path.resolve(sourcePath)),
                );
                const cleanupPlan = await prepareAgentDeleteCleanupPaths(
                  unfencedSourcePaths,
                  journal.cleanupPaths,
                );
                const unresolvedPath = cleanupPlan.find(
                  (cleanupPath) =>
                    cleanupPath.preparationError !== undefined &&
                    cleanupPath.sourcePaths.some((sourcePath) =>
                      unfencedSourcePathSet.has(path.resolve(sourcePath)),
                    ),
                );
                if (unresolvedPath) {
                  throw unresolvedPath.preparationError;
                }
                deletion.fenceCleanupPaths(
                  cleanupPlan.map(
                    ({
                      path: cleanupPath,
                      trashPath,
                      parentPath,
                      kind,
                      preparedIdentity,
                      trashCoversDescendants,
                      done,
                      note,
                      sourcePaths,
                    }) => {
                      const journalPath: AgentDeletionJournalCleanupPath = {
                        path: cleanupPath,
                        canonicalPath: trashPath,
                        parentPath,
                        kind,
                        sourcePaths,
                        dev: preparedIdentity?.dev ?? null,
                        ino: preparedIdentity?.ino ?? null,
                        coversDescendants: trashCoversDescendants,
                        done,
                      };
                      if (note) {
                        journalPath.note = note;
                      }
                      return journalPath;
                    },
                  ),
                );
              }
            }
            await context.cron.removeAgentJobsTransactional(agentId, () =>
              withAgentExecApprovalsRemoved(agentId, async () => {
                deletion.assertCurrent();
                if (!rosterCommitted) {
                  try {
                    committed = await deleteAgentConfigEntry({
                      agentId,
                      allowConfigSizeDrop: true,
                      assertCurrent: deletion.assertCurrent,
                    });
                  } catch (error) {
                    try {
                      const persisted = await readConfigFileSnapshotForWrite();
                      if (!isConfiguredAgent(persisted.snapshot.sourceConfig, agentId)) {
                        rosterCommitted = true;
                        throw new AgentDeletionCommitUncertainError(error);
                      }
                    } catch (readError) {
                      if (readError instanceof AgentDeletionCommitUncertainError) {
                        throw readError;
                      }
                      throw new AgentDeletionCommitUncertainError(error);
                    }
                    throw error;
                  }
                  if (!committed.result) {
                    rosterCommitted = !isConfiguredAgent(committed.nextConfig, agentId);
                    const missingResultError = new Error(
                      "agent delete config mutation did not return its target",
                    );
                    if (rosterCommitted) {
                      throw new AgentDeletionCommitUncertainError(missingResultError);
                    }
                    throw missingResultError;
                  }
                  rosterCommitted = true;
                }
              }),
            );
            deletion.assertCurrent();
          } catch (error) {
            let canReleaseFence =
              !rosterCommitted &&
              !lockedJournal &&
              !(error instanceof AgentDeletionAuthorityRollbackError) &&
              !(error instanceof AgentDeletionCommitUncertainError);
            if (canReleaseFence) {
              try {
                const persisted = await readConfigFileSnapshotForWrite();
                canReleaseFence = isConfiguredAgent(persisted.snapshot.sourceConfig, agentId);
              } catch {
                canReleaseFence = false;
              }
            }
            if (canReleaseFence) {
              deletion.rollback();
            }
            throw error;
          }

          const deleteResult = committed?.result ?? {
            agentDir: journal.agentDir,
            workspaceDir: journal.workspaceDir,
            sessionsDir: journal.sessionsDir,
            removedBindings: 0,
          };
          const nextConfig = committed?.nextConfig ?? lockedConfig;

          // A journaled path is trash-eligible only while registry ownership still points at the
          // deleted agent; recovery must not consume a path claimed by a surviving agent.
          const agentDirRegistryPath = normalizeAgentDirRegistryPath(deleteResult.agentDir);
          const purgeFailed = await purgeAgentSessionStoreEntries(lockedConfig, agentId, {
            runDatabaseCleanup: deletion.runDatabaseCleanup,
          });
          deletion.assertCurrent();

          const removed: AgentDeleteRemovedPath[] = [];
          const failed: AgentDeleteFailedPath[] = [];

          if (deleteFiles && !purgeFailed) {
            const survivingDatabaseFilePaths = resolveSurvivingDatabaseFilePaths(
              readAgentDeleteDatabaseRegistry(),
              agentId,
            );
            const workspaceTrashEligible = !isPathOwnedBySurvivingAgent(
              nextConfig,
              agentId,
              deleteResult.workspaceDir,
              survivingDatabaseFilePaths,
            );
            // The config mutation lock and durable journal fence block new roster and database
            // claims across this final ownership recheck and the filesystem cleanup below.
            const agentDirTrashEligible =
              resolveRegisteredAgentIdForDir(deleteResult.agentDir) === agentId &&
              !isPathOwnedBySurvivingAgent(
                nextConfig,
                agentId,
                deleteResult.agentDir,
                survivingDatabaseFilePaths,
              );
            const sessionsDirTrashEligible = !isPathOwnedBySurvivingAgent(
              nextConfig,
              agentId,
              deleteResult.sessionsDir,
              survivingDatabaseFilePaths,
            );
            const databaseFilePaths = [
              ...(agentDirTrashEligible
                ? (databasePlan?.relocatedFileGroups ?? [])
                : (databasePlan?.fileGroups ?? [])
              ).flat(),
              ...journal.databasePaths,
            ].filter(
              (pathname) =>
                !isPathOwnedBySurvivingAgent(
                  nextConfig,
                  agentId,
                  pathname,
                  survivingDatabaseFilePaths,
                ),
            );
            const eligibleSourcePaths = new Set(
              [
                ...(workspaceTrashEligible ? [deleteResult.workspaceDir] : []),
                ...(agentDirTrashEligible ? [deleteResult.agentDir] : []),
                ...(sessionsDirTrashEligible ? [deleteResult.sessionsDir] : []),
                ...databaseFilePaths,
              ].map((sourcePath) => path.resolve(sourcePath)),
            );
            const cleanupPaths = (
              await prepareAgentDeleteCleanupPaths([], journal.cleanupPaths)
            ).filter(
              (cleanupPath) =>
                cleanupPath.sourcePaths.some((sourcePath) => eligibleSourcePaths.has(sourcePath)) &&
                (agentDirTrashEligible ||
                  !cleanupPathCovers(cleanupPath, deleteResult.agentDir, agentDirRegistryPath)),
            );
            const workspaceCanonicalPath = normalizeAgentDirRegistryPath(deleteResult.workspaceDir);
            const workspaceCleanupPaths = cleanupPaths.filter((cleanupPath) =>
              cleanupPathCovers(cleanupPath, deleteResult.workspaceDir, workspaceCanonicalPath),
            );
            const legacyPlan =
              workspaceCleanupPaths.length > 0
                ? prepareLegacyWorkspaceStateReset(deleteResult.workspaceDir)
                : undefined;
            const statePlan =
              workspaceCleanupPaths.length > 0
                ? prepareWorkspaceStateDeletion(deleteResult.workspaceDir)
                : undefined;
            const outcomes: Array<{
              cleanupPath: AgentDeleteCleanupPath;
              outcome: AgentDeletePathOutcome;
            }> = [];
            const completedCleanupPaths = new Set(
              cleanupPaths.filter((cleanupPath) => cleanupPath.done),
            );
            const markCleanupPathDone = (cleanupPath: AgentDeleteCleanupPath, note?: string) => {
              const canonicalPath = path.resolve(cleanupPath.trashPath);
              deletion.fenceCleanupPaths(
                journal.cleanupPaths.map((entry) => {
                  if (
                    path.resolve(entry.canonicalPath) !== canonicalPath ||
                    entry.kind !== cleanupPath.kind
                  ) {
                    return entry;
                  }
                  const updated = Object.assign({}, entry, { done: true });
                  if (note) {
                    updated.note = note;
                  }
                  return updated;
                }),
              );
              cleanupPath.done = true;
              cleanupPath.note = note;
              completedCleanupPaths.add(cleanupPath);
            };
            const protectedCleanupPaths: Array<{
              cleanupPath: AgentDeleteCleanupPath;
              protectAliases: boolean;
              terminal: boolean;
              note?: string;
            }> = [];
            for (const cleanupPath of cleanupPaths) {
              deletion.assertCurrent();
              if (cleanupPath.done) {
                let replacementPresent = true;
                let note =
                  cleanupPath.note ?? "completed cleanup path is occupied; replacement preserved";
                try {
                  await statAgentCleanupPath(cleanupPath);
                } catch (error) {
                  if (isMissingPathError(error)) {
                    replacementPresent = false;
                  } else if (!(error instanceof AgentCleanupIdentityMismatchError)) {
                    note = "completed cleanup path could not be verified; replacement preserved";
                  }
                }
                if (replacementPresent) {
                  markCleanupPathDone(cleanupPath, note);
                  protectedCleanupPaths.push({
                    cleanupPath,
                    protectAliases: true,
                    terminal: true,
                    note,
                  });
                }
                continue;
              }
              const refreshedDatabaseFilePaths = resolveSurvivingDatabaseFilePaths(
                readAgentDeleteDatabaseRegistry(),
                agentId,
              );
              const blockingProtection = protectedCleanupPaths.find(
                ({ cleanupPath: protectedPath, protectAliases }) =>
                  ((cleanupPath.kind !== "symlink" || protectAliases) &&
                    (protectedPath.canonicalPath === cleanupPath.canonicalPath ||
                      isPathInside(cleanupPath.canonicalPath, protectedPath.canonicalPath))) ||
                  [
                    protectedPath.trashPath,
                    ...(protectAliases ? protectedPath.sourcePaths : []),
                  ].some(
                    (protectedSourcePath) =>
                      protectedSourcePath === cleanupPath.trashPath ||
                      isPathInside(cleanupPath.trashPath, protectedSourcePath),
                  ),
              );
              const ownedBySurvivor =
                isPathOwnedBySurvivingAgent(
                  nextConfig,
                  agentId,
                  cleanupPath.path,
                  refreshedDatabaseFilePaths,
                ) ||
                (cleanupPathCovers(cleanupPath, deleteResult.agentDir, agentDirRegistryPath) &&
                  resolveRegisteredAgentIdForDir(deleteResult.agentDir) !== agentId);
              if (blockingProtection || ownedBySurvivor) {
                const terminal = ownedBySurvivor || blockingProtection?.terminal === true;
                const note = ownedBySurvivor
                  ? "replacement owned by a surviving agent"
                  : blockingProtection?.note;
                if (terminal) {
                  markCleanupPathDone(cleanupPath, note ?? "protected replacement preserved");
                }
                protectedCleanupPaths.push({
                  cleanupPath,
                  protectAliases: blockingProtection?.protectAliases ?? false,
                  terminal,
                  note,
                });
                continue;
              }
              const outcome = cleanupPath.preparationError
                ? cleanupFailure(cleanupPath.path, cleanupPath.preparationError)
                : await removeAgentPath(cleanupPath, deletion.assertCurrent);
              outcomes.push({
                cleanupPath,
                outcome,
              });
              if ("removed" in outcome) {
                markCleanupPathDone(cleanupPath);
              } else if ("skipped" in outcome) {
                markCleanupPathDone(cleanupPath, outcome.skipped.reason);
                protectedCleanupPaths.push({
                  cleanupPath,
                  protectAliases: true,
                  terminal: true,
                  note: outcome.skipped.reason,
                });
              } else {
                protectedCleanupPaths.push({
                  cleanupPath,
                  protectAliases: true,
                  terminal: false,
                });
              }
            }
            for (const { outcome } of outcomes) {
              if ("removed" in outcome) {
                removed.push(outcome.removed);
              } else if ("failed" in outcome) {
                failed.push(outcome.failed);
              }
            }
            if (
              workspaceCleanupPaths.length > 0 &&
              workspaceCleanupPaths.every((cleanupPath) =>
                completedCleanupPaths.has(cleanupPath),
              ) &&
              legacyPlan &&
              statePlan
            ) {
              try {
                await removeLegacyWorkspaceStateForReset(legacyPlan, {
                  assertCurrent: deletion.assertCurrent,
                });
                deletion.assertCurrent();
                await deleteWorkspaceState(statePlan, { assertCurrent: deletion.assertCurrent });
              } catch {
                // Best-effort cleanup. A later explicit reset can remove stale rows.
              }
            }
            deletion.assertCurrent();
            const agentDirCleanupPaths = cleanupPaths.filter((cleanupPath) =>
              cleanupPathCovers(cleanupPath, deleteResult.agentDir, agentDirRegistryPath),
            );
            if (
              agentDirCleanupPaths.length > 0 &&
              agentDirCleanupPaths.every((cleanupPath) => completedCleanupPaths.has(cleanupPath))
            ) {
              unregisterResolvedAgentDir({ agentId, agentDir: agentDirRegistryPath });
            }
          }
          deletion.assertCurrent();
          if (failed.length === 0 && !purgeFailed) {
            unregisterResolvedAgentDir({ agentId, agentDir: agentDirRegistryPath });
            if (deleteFiles) {
              unregisterAgentDeleteDatabases(agentId, databasePlan?.registrationPaths ?? []);
            }
            deletion.finish();
          }
          return {
            ok: true,
            agentId,
            removedBindings: deleteResult.removedBindings,
            removed,
            failed,
            ...(purgeFailed ? { purgeFailed: true as const } : {}),
          };
        }),
      );
      respond(true, result, undefined);
    } catch (error) {
      if (
        error instanceof AgentSharedAuthStoreOwnerError ||
        error instanceof AgentSharedStoreOwnerError
      ) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, error.message));
        return;
      }
      if (error instanceof AgentConfigPreconditionError) {
        respondAgentNotFound(respond, agentId);
        return;
      }
      throw error;
    }
  },
  ...agentFileHandlers,
};
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */

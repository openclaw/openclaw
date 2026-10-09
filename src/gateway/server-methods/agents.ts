import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolvePathPrefixSync } from "@openclaw/fs-safe/advanced";
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
  finishAgentDeleteDatabases,
  isPathOwnedBySurvivingAgent,
  prepareAgentDeleteDatabases,
  prepareJournaledAgentDirOwnership,
  readAgentDeleteDatabaseRegistry,
  resolveSurvivingDatabaseFilePaths,
  retireAgentDeleteRuntime,
  type AgentDeleteDatabasePlan,
} from "../../agents/agent-delete-databases.js";
import {
  formatSharedAuthStoreOwnerDeleteError,
  isInheritedAuthStoreOwner,
  isSharedAuthStoreOwner,
} from "../../agents/agent-delete-safety.js";
import {
  normalizeAgentDirRegistryPath,
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
  createAgentIdentityConfig,
  normalizeIdentityForFile,
  sanitizeAgentIdentityLine,
} from "../../agents/identity-file.js";
import { resolveAgentIdentity } from "../../agents/identity.js";
import { getAgentWorkspaceAccess } from "../../agents/workspace-access.js";
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
import { resolveUserPath } from "../../utils.js";
import { reviveAgentDatabasesAfterConfigCommit } from "../server-reload-agent-databases.js";
import { SessionMutationAuthorizationChangedError } from "../session-mutation-authorization-error.js";
import { captureGatewayClientUploadCommitGuard } from "../upload-policy.js";
import {
  AgentConfigPreconditionError,
  AgentModelSelectionError,
  deleteAgentConfigEntry,
  isConfiguredAgent,
  isImplicitAgentModelUpdate,
  updateAgentConfigEntry,
  validateAgentModelSelectionUpdate,
} from "./agents-config-mutations.js";
import {
  agentFileHandlers,
  buildIdentityMarkdownOrRespondUnsafe,
  writeWorkspaceFileOrRespond,
} from "./agents-files.js";
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
  const candidate = path.resolve(pathname);
  try {
    return await fs.realpath(candidate);
  } catch (error) {
    if (!isMissingPathError(error)) {
      throw error;
    }
    const { existingPath, unresolvedSegments } = resolvePathPrefixSync(candidate);
    return path.resolve(existingPath, ...unresolvedSegments);
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
    addPath({
      path: resolvedPath,
      parentPath: path.dirname(resolvedPath),
      canonicalPath,
      trashPath: resolvedPath,
      trashCoversDescendants: targetStat ? !targetStat.isSymbolicLink() : false,
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

export const agentsHandlers: GatewayRequestHandlers = {
  "agents.list": agentListHandler,
  "agents.create": async ({ params, respond, client, context }) => {
    if (!assertValidParams(params, validateAgentsCreateParams, "agents.create", respond)) {
      return;
    }

    try {
      const result = await createAgent({
        name: params.name,
        workspace: params.workspace,
        model: params.model,
        emoji: params.emoji,
        avatar: params.avatar,
        assertIdentityInputAllowed: captureGatewayClientUploadCommitGuard({
          method: "agents.create",
          requestParams: params,
          client,
          context,
        }),
      });
      if (result.status === "error") {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, result.message));
        return;
      }
      await reviveAgentDatabasesAfterConfigCommit([result.agentId], (message) =>
        context.logGateway.warn(message),
      );
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
    } catch (error) {
      if (error instanceof SessionMutationAuthorizationChangedError) {
        respond(false, undefined, error.error);
        return;
      }
      throw error;
    }
  },
  "agents.update": async ({ params, respond, context, client }) => {
    if (!assertValidParams(params, validateAgentsUpdateParams, "agents.update", respond)) {
      return;
    }

    const assertUploadCurrent = captureGatewayClientUploadCommitGuard({
      method: "agents.update",
      requestParams: params,
      client,
      context,
    });
    let identityPublished = false;
    const assertUploadAllowed = () => {
      if (!identityPublished) {
        assertUploadCurrent?.();
      }
    };
    const cfg = context.getRuntimeConfig();
    const normalized = normalizeAgentIdStrict(params.agentId);
    if (!normalized.ok) {
      respondAgentNotFound(respond, params.agentId);
      return;
    }
    const agentId = normalized.value;
    const workspace = resolveOptionalStringParam(params.workspace);
    const workspaceDir = workspace ? resolveUserPath(workspace) : undefined;

    const model = params.model === null ? null : resolveOptionalStringParam(params.model);

    const name = resolveOptionalStringParam(params.name);
    const safeName = name ? sanitizeAgentIdentityLine(name) : undefined;

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

    try {
      let ensuredWorkspace: Awaited<ReturnType<typeof ensureAgentWorkspace>> | undefined;
      if (workspaceDir) {
        const skipBootstrap = Boolean(nextConfig.agents?.defaults?.skipBootstrap);
        ensuredWorkspace = await ensureAgentWorkspace({
          dir: workspaceDir,
          guard: { assertHost: assertUploadAllowed },
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
          assertUploadAllowed?.();
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
            assertCurrent: assertWorkspaceAccessCurrent,
          }))
        ) {
          return;
        }
        // The write accepted these exact bytes. Settle their config projection,
        // without retiring workspace authority or admitting another upload.
        identityPublished = true;
        assertWorkspaceAccessCurrent();
      }

      await updateAgentConfigEntry({ ...agentConfigUpdate, assertCurrent: assertUploadAllowed });
    } catch (error) {
      if (error instanceof SessionMutationAuthorizationChangedError) {
        respond(false, undefined, error.error);
        return;
      }
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

    const requestedDeleteFiles = params.deleteFiles ?? true;
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
            const claimed = await claimCompletedAgentDeletion(agentId, lockedJournal.operationId);
            const remainingJournal = readAgentDeletionJournal(agentId);
            if (!claimed && remainingJournal) {
              throw new Error(
                `agent "${agentId}" deletion tombstone changed before fresh deletion`,
              );
            }
            lockedJournal = undefined;
          }
          const deleteFiles = lockedJournal?.deleteFiles ?? requestedDeleteFiles;
          const deletion = await begin(
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
                  cleanupPlan.map((cleanupPath) => {
                    const journalPath: AgentDeletionJournalCleanupPath = {
                      path: cleanupPath.path,
                      canonicalPath: cleanupPath.trashPath,
                      parentPath: cleanupPath.parentPath,
                      kind: cleanupPath.kind,
                      sourcePaths: cleanupPath.sourcePaths,
                      dev: cleanupPath.preparedIdentity?.dev ?? null,
                      ino: cleanupPath.preparedIdentity?.ino ?? null,
                      coversDescendants: cleanupPath.trashCoversDescendants,
                      done: cleanupPath.done,
                    };
                    if (cleanupPath.note) {
                      journalPath.note = cleanupPath.note;
                    }
                    return journalPath;
                  }),
                );
              }
            }
            await context.cron.removeAgentJobsTransactional(agentId, () =>
              withAgentExecApprovalsRemoved(deletion.entry, async () => {
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
              await deletion.rollback();
            }
            throw error;
          }

          await retireAgentDeleteRuntime(
            lockedConfig,
            deletion,
            databasePlan?.agentDirs ?? [journal.agentDir],
          );

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
          await deletion.assertCurrentAsync();
          const { closeDeletedAgentDatabases } =
            await import("../../state/openclaw-agent-db-readers.js");
          await deletion.assertCurrentAsync();
          await closeDeletedAgentDatabases(agentId, databasePlan?.readerPaths ?? []);
          await deletion.assertCurrentAsync();

          const removed: AgentDeleteRemovedPath[] = [];
          const failed: AgentDeleteFailedPath[] = [];

          if (deleteFiles && !purgeFailed) {
            const survivingDatabaseFilePaths = resolveSurvivingDatabaseFilePaths(
              readAgentDeleteDatabaseRegistry(),
              agentId,
            );
            const unclaimedBySurvivor = (pathname: string) =>
              !isPathOwnedBySurvivingAgent(
                nextConfig,
                agentId,
                pathname,
                survivingDatabaseFilePaths,
              );
            const workspaceTrashEligible = unclaimedBySurvivor(deleteResult.workspaceDir);
            // The config mutation lock and durable journal fence block new roster and database
            // claims across this final ownership recheck and the filesystem cleanup below.
            const agentDirTrashEligible =
              resolveRegisteredAgentIdForDir(deleteResult.agentDir) === agentId &&
              unclaimedBySurvivor(deleteResult.agentDir);
            const sessionsDirTrashEligible = unclaimedBySurvivor(deleteResult.sessionsDir);
            const databaseFilePaths = [
              ...(agentDirTrashEligible
                ? (databasePlan?.relocatedFileGroups ?? [])
                : (databasePlan?.fileGroups ?? [])
              ).flat(),
              ...journal.databasePaths,
            ].filter(unclaimedBySurvivor);
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
              if ("removed" in outcome) {
                removed.push(outcome.removed);
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
                failed.push(outcome.failed);
                protectedCleanupPaths.push({
                  cleanupPath,
                  protectAliases: true,
                  terminal: false,
                });
              }
            }
            if (
              workspaceCleanupPaths.length > 0 &&
              workspaceCleanupPaths.every((cleanupPath) => cleanupPath.done) &&
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
              agentDirCleanupPaths.every((cleanupPath) => cleanupPath.done)
            ) {
              unregisterResolvedAgentDir({ agentId, agentDir: agentDirRegistryPath });
            }
          }
          await finishAgentDeleteDatabases({
            deletion,
            databasePlan,
            agentDir: agentDirRegistryPath,
            deleteFiles,
            complete: failed.length === 0 && !purgeFailed,
          });
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

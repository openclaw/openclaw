import fs from "node:fs";
import path from "node:path";
import { err, ok, type Result } from "@openclaw/normalization-core/result";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  type ErrorShape,
  type SessionsCreateParams,
} from "../../packages/gateway-protocol/src/index.js";
import { InvalidWorktreeBaseRefError, resolveWorktreeBase } from "../agents/worktrees/base-ref.js";
import { slugifyWorktreeTitle } from "../agents/worktrees/name.js";
import { managedWorktrees, WorktreeRepositoryError } from "../agents/worktrees/service.js";
import type { CreateManagedWorktreeParams } from "../agents/worktrees/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { isPathInside } from "../infra/path-guards.js";
import { resolveProjectRegistry } from "../projects/project-registry.js";
import { prepareSessionCreateFilesystemRoot } from "./server-methods/session-create-root.js";
import type { PrepareGatewaySessionLifecycle } from "./session-lifecycle-preparation.js";
import { loadGatewaySessionEntryReadOnly } from "./session-utils-store.js";

export function validateSessionWorktreeSelection(
  params: SessionsCreateParams,
): ErrorShape | undefined {
  if (
    params.worktreeSource === "empty" &&
    (params.worktree !== true ||
      params.cwd ||
      params.projectId ||
      params.projectGitUrl ||
      params.repository ||
      params.catalogId ||
      params.execNode ||
      params.worktreeBaseRef)
  ) {
    return errorShape(
      ErrorCodes.INVALID_REQUEST,
      "sessions.create worktreeSource=empty requires worktree=true and cannot include another workspace source, catalog, execNode, or worktreeBaseRef",
    );
  }
  if (normalizeOptionalString(params.execNode) && params.worktree === true) {
    return errorShape(
      ErrorCodes.INVALID_REQUEST,
      "sessions.create worktree cannot target execNode",
    );
  }
  if (
    (normalizeOptionalString(params.worktreeBaseRef) ||
      normalizeOptionalString(params.worktreeName)) &&
    params.worktree !== true
  ) {
    return errorShape(
      ErrorCodes.INVALID_REQUEST,
      "sessions.create worktreeBaseRef/worktreeName require worktree=true",
    );
  }
  return undefined;
}

export function resolveSpawnParentWorktreeSource(
  parentSessionKey: string,
  agentId: string,
  assertCallerCurrent: (() => void) | undefined,
) {
  const parent = loadGatewaySessionEntryReadOnly(parentSessionKey, { agentId });
  if (!parent.entry) {
    return undefined;
  }
  if (!parent.entry.worktree) {
    const projectId = normalizeOptionalString(parent.entry.projectId);
    if (!projectId) {
      return undefined;
    }
    const project = resolveProjectRegistry(parent.cfg, projectId);
    if (!project) {
      throw new Error("Spawn parent project changed; retry from its current session");
    }
    const parentSessionId = parent.entry.sessionId;
    const assertCurrent = () => {
      assertCallerCurrent?.();
      const current = loadGatewaySessionEntryReadOnly(parent.canonicalKey, { agentId });
      const currentProject = resolveProjectRegistry(current.cfg, projectId);
      if (
        current.entry?.sessionId !== parentSessionId ||
        current.entry.archivedAt !== undefined ||
        current.entry.projectId !== projectId ||
        current.entry.sessionRoot !== project.repoRoot ||
        current.entry.worktree !== undefined ||
        currentProject?.repoRoot !== project.repoRoot
      ) {
        throw new Error("Spawn parent project changed; retry from its current session");
      }
    };
    assertCurrent();
    return { workspace: project.repoRoot, assertCurrent };
  }
  const worktree = managedWorktrees.findLiveByOwner("session", parent.canonicalKey);
  if (
    !worktree ||
    worktree.id !== parent.entry.worktree.id ||
    parent.entry.archivedAt !== undefined
  ) {
    throw new Error("Spawn parent managed worktree changed; retry from its current session");
  }
  const parentSessionId = parent.entry.sessionId;
  // Validate the inherited source through the child creation commit. After that,
  // persisted workspace intent belongs to the child and uses its admitted run.
  const assertCurrent = () => {
    assertCallerCurrent?.();
    const current = loadGatewaySessionEntryReadOnly(parent.canonicalKey, { agentId });
    const currentWorktree = managedWorktrees.findLiveByOwner("session", parent.canonicalKey);
    if (
      current.entry?.sessionId !== parentSessionId ||
      current.entry.archivedAt !== undefined ||
      current.entry.worktree?.id !== worktree.id ||
      currentWorktree?.id !== worktree.id ||
      currentWorktree.repoRoot !== worktree.repoRoot ||
      currentWorktree.path !== worktree.path
    ) {
      throw new Error("Spawn parent managed worktree changed; retry from its current session");
    }
  };
  return { workspace: worktree.repoRoot, assertCurrent };
}

/** Resolve explicit session selections through the same typed error boundary. */
export async function resolveSessionWorktreeBase(
  workspace: string,
  baseRef: string,
  signal?: AbortSignal,
): Promise<Result<string, ErrorShape>> {
  try {
    return ok((await resolveWorktreeBase(workspace, baseRef, signal)).commit);
  } catch (error) {
    return err(
      errorShape(
        error instanceof InvalidWorktreeBaseRefError
          ? ErrorCodes.INVALID_REQUEST
          : ErrorCodes.UNAVAILABLE,
        formatErrorMessage(error),
      ),
    );
  }
}

/** One worktree preparation owner for synchronous creation and admitted first turns. */
export async function prepareSessionWorktree(params: {
  cfg: OpenClawConfig;
  target: Parameters<PrepareGatewaySessionLifecycle>[0];
  workspace: string | { kind: "empty" };
  name?: string;
  baseRef?: string;
  checkoutCommit?: string;
  label?: string;
  runSetupScript: boolean;
  signal?: AbortSignal;
  commitGuard?: () => void;
  onProgress?: CreateManagedWorktreeParams["onProgress"];
}): ReturnType<PrepareGatewaySessionLifecycle> {
  const { target, commitGuard } = params;
  try {
    commitGuard?.();
    const workspace = typeof params.workspace === "string" ? params.workspace : undefined;
    // The empty source contributes no host files; caller-selected sources still
    // require the inherited workspace containment check.
    if (target.sandboxRequired && workspace) {
      const root = prepareSessionCreateFilesystemRoot({
        cfg: params.cfg,
        enforceSandboxContainment: true,
        sandboxRequired: true,
        requestedProjectId: target.projectId ?? target.entry?.projectId,
        sessionCwd: workspace,
        sessionKey: target.key,
        targetAgentId: target.agentId,
      });
      if (!root.ok) {
        return root;
      }
    }
    const repository = workspace
      ? await managedWorktrees.resolveRepositoryPaths(workspace)
      : undefined;
    commitGuard?.();
    const boundId = normalizeOptionalString(target.entry?.worktree?.id);
    let existing = boundId ? managedWorktrees.findLiveById(boundId) : undefined;
    if (existing && (existing.ownerKind !== "session" || existing.ownerId !== target.key)) {
      return err(
        errorShape(ErrorCodes.UNAVAILABLE, "session worktree binding has a different owner"),
      );
    }
    existing ??= managedWorktrees.findLiveByOwner("session", target.key);
    let existingDirectory = false;
    if (existing) {
      try {
        existingDirectory = fs.lstatSync(existing.path).isDirectory();
      } catch {
        // Missing registry targets are replaced by create() under its owner lease.
      }
    }
    if (existing && existingDirectory) {
      if (repository && existing.repoRoot !== repository.canonicalRoot) {
        return err(
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            "session worktree belongs to a different repository",
          ),
        );
      }
      // Replaying the recorded selection reuses the checkout; changing it must not rebase it.
      if (
        (params.name && existing.name !== params.name) ||
        (params.baseRef && existing.baseRef !== params.baseRef)
      ) {
        return err(
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `session is already bound to worktree ${existing.name} (${existing.branch})`,
          ),
        );
      }
    }
    commitGuard?.();
    const createParams = {
      ownerKind: "session" as const,
      ownerId: target.key,
      name: params.name,
      suggestedName: slugifyWorktreeTitle(params.label ?? ""),
      signal: params.signal,
      commitGuard,
      onProgress: params.onProgress,
    };
    const { record: worktree, materialized } = workspace
      ? await managedWorktrees.createWithOutcome({
          ...createParams,
          repoRoot: workspace,
          baseRef: params.baseRef,
          checkoutCommit: params.checkoutCommit,
          runSetupScript: params.runSetupScript,
        })
      : await managedWorktrees.createEmptyWithOutcome(createParams);
    const rollback = materialized
      ? async () => {
          await managedWorktrees.remove({
            id: worktree.id,
            reason: "session-create-failed",
            allowSnapshotLoss: true,
          });
        }
      : undefined;
    try {
      commitGuard?.();
      // A nested source workspace keeps its relative cwd inside the new checkout.
      let spawnedCwd = worktree.path;
      const relative =
        repository && workspace
          ? path.relative(repository.sourceRoot, fs.realpathSync(workspace))
          : "";
      const nestedCwd = path.resolve(worktree.path, relative);
      if (relative && isPathInside(worktree.path, nestedCwd)) {
        spawnedCwd = nestedCwd;
        fs.mkdirSync(spawnedCwd, { recursive: true });
      }
      return ok({
        spawnedCwd,
        sessionRoot: fs.realpathSync(worktree.path),
        worktree: {
          id: worktree.id,
          branch: worktree.branch,
          repoRoot: worktree.repoRoot,
          canonicalWorkspaceDir: workspace ?? worktree.repoRoot,
        },
        ...(rollback ? { rollback } : {}),
      });
    } catch (error) {
      await rollback?.();
      throw error;
    }
  } catch (error) {
    // Closed delegated authority remains an exception for its admission owner.
    commitGuard?.();
    const invalidRequest =
      error instanceof WorktreeRepositoryError || error instanceof InvalidWorktreeBaseRefError;
    return err(
      errorShape(
        invalidRequest ? ErrorCodes.INVALID_REQUEST : ErrorCodes.UNAVAILABLE,
        formatErrorMessage(error),
      ),
    );
  }
}

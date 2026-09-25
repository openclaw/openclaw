import fs from "node:fs";
import path from "node:path";
import { collectNestedErrorCandidates } from "@openclaw/normalization-core/error-coercion";
import { err, ok, type Result } from "@openclaw/normalization-core/result";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  type ErrorShape,
  type SessionsCreateParams,
} from "../../packages/gateway-protocol/src/index.js";
import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { resolveSandboxRuntimeStatus } from "../agents/sandbox/runtime-status.js";
import { InvalidWorktreeBaseRefError, resolveWorktreeBase } from "../agents/worktrees/base-ref.js";
import { insideGitCheckout } from "../agents/worktrees/git.js";
import { slugifyWorktreeTitle } from "../agents/worktrees/name.js";
import { getRegistryWorktree } from "../agents/worktrees/registry.js";
import { managedWorktrees, WorktreeRepositoryError } from "../agents/worktrees/service.js";
import type {
  CreateManagedWorktreeParams,
  WorktreeSourceStage,
} from "../agents/worktrees/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { isPathInside } from "../infra/path-guards.js";
import {
  resolveWorkspaceProject,
  selectStoredProjectRegistry,
} from "../projects/project-registry.js";
import { generateWorktreeSessionTitle } from "./dashboard-session-title.js";
import { prepareSessionCreateFilesystemRoot } from "./server-methods/session-create-root.js";
import type {
  PrepareGatewaySessionLifecycle,
  PreparedGatewaySessionLifecycle,
} from "./session-create-service.types.js";
import { invalidSessionRequest } from "./session-request-error.js";
import { resolveExplicitSessionName } from "./session-title-state.js";
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

type AcceptedWorktreeSource = NonNullable<
  PreparedGatewaySessionLifecycle["pendingWorktree"]
>["source"];

type SpawnParentWorktreeSource = {
  workspace: string;
  source?: AcceptedWorktreeSource;
  withCurrent: WorktreeSourceStage;
  withRollback?: <T>(run: (assertCurrent: () => void) => Promise<T>) => Promise<T>;
};

class SessionWorktreeSourceChangedError extends Error {}

async function resolveSpawnParentWorktreeSource(
  parentSessionKey: string,
  agentId: string,
  options: { signal?: AbortSignal } = {},
): Promise<SpawnParentWorktreeSource | undefined> {
  const parent = loadGatewaySessionEntryReadOnly(parentSessionKey, { agentId });
  if (!parent.entry) {
    return undefined;
  }
  if (!parent.entry.worktree) {
    const projectId = normalizeOptionalString(parent.entry.projectId);
    if (!projectId) {
      return undefined;
    }
    const selection = projectId.startsWith("workspace:")
      ? undefined
      : await selectStoredProjectRegistry(projectId, options);
    const project = selection?.project ?? resolveWorkspaceProject(parent.cfg, projectId);
    if (!project) {
      throw new SessionWorktreeSourceChangedError(
        "Spawn parent project changed; retry from its current session",
      );
    }
    const parentSessionId = parent.entry.sessionId;
    const assertParentCurrent = (storedRoot: string | undefined, assertCheckout?: () => void) => {
      assertCheckout?.();
      const current = loadGatewaySessionEntryReadOnly(parent.canonicalKey, { agentId });
      const currentProjectRoot = selection
        ? storedRoot
        : resolveWorkspaceProject(current.cfg, projectId)?.repoRoot;
      if (
        current.entry?.sessionId !== parentSessionId ||
        current.entry.archivedAt !== undefined ||
        current.entry.projectId !== projectId ||
        current.entry.sessionRoot !== project.repoRoot ||
        current.entry.worktree !== undefined ||
        currentProjectRoot !== project.repoRoot
      ) {
        throw new SessionWorktreeSourceChangedError(
          "Spawn parent project changed; retry from its current session",
        );
      }
    };
    if (selection) {
      return {
        workspace: project.repoRoot,
        source: { kind: "project", id: projectId },
        withRollback: selection.withRollback,
        withCurrent: async (run) =>
          await selection.withCurrent((current) => {
            const assertCurrent = () =>
              assertParentCurrent(current.project?.repoRoot, current.assertCurrent);
            return run({
              assertCurrent,
              assertCheckoutCurrent: current.assertCheckoutCurrent,
              signal: current.signal,
            });
          }),
      };
    }
    const assertCurrent = () => assertParentCurrent(undefined);
    assertCurrent();
    return {
      workspace: project.repoRoot,
      source: { kind: "project", id: projectId },
      withCurrent: async (run) => {
        return await run({ assertCurrent, signal: options.signal });
      },
    };
  }
  const worktree = managedWorktrees.findLiveByOwner("session", parent.canonicalKey);
  if (
    !worktree ||
    worktree.id !== parent.entry.worktree.id ||
    parent.entry.archivedAt !== undefined
  ) {
    throw new SessionWorktreeSourceChangedError(
      "Spawn parent managed worktree changed; retry from its current session",
    );
  }
  const parentSessionId = parent.entry.sessionId;
  // Validate the inherited source through the child creation commit. After that,
  // persisted workspace intent belongs to the child and uses its admitted run.
  const assertCurrent = () => {
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
      throw new SessionWorktreeSourceChangedError(
        "Spawn parent managed worktree changed; retry from its current session",
      );
    }
  };
  return {
    workspace: worktree.repoRoot,
    source: { kind: "worktree", id: worktree.id },
    withCurrent: async (run) => {
      return await run({ assertCurrent, signal: options.signal });
    },
  };
}

/** Resolve explicit session selections through the same typed error boundary. */
export async function resolveSessionWorktreeBase(
  workspace: string,
  baseRef: string,
  signal?: AbortSignal,
  commitGuard?: () => void,
): Promise<Result<string, ErrorShape>> {
  try {
    return ok((await resolveWorktreeBase(workspace, baseRef, signal, commitGuard)).commit);
  } catch (error) {
    commitGuard?.();
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
  withSource?: WorktreeSourceStage;
  acceptedSource?: AcceptedWorktreeSource;
  withRollback?: SpawnParentWorktreeSource["withRollback"];
  onProgress?: CreateManagedWorktreeParams["onProgress"];
}): ReturnType<PrepareGatewaySessionLifecycle> {
  const { target, commitGuard } = params;
  const sandboxRequired =
    target.sandboxRequired === true ||
    target.entry?.sandbox === "required" ||
    resolveSandboxRuntimeStatus({
      cfg: params.cfg,
      agentId: target.agentId,
      sessionKey: target.key,
    }).sandboxed;
  let withSource = params.withSource;
  let withRollback = params.withRollback;
  const checkSource = async () => {
    commitGuard?.();
    await withSource?.((current) => {
      commitGuard?.();
      current.assertCurrent();
    });
  };
  try {
    await checkSource();
    const workspace = typeof params.workspace === "string" ? params.workspace : undefined;
    if (sandboxRequired && workspace && !withSource && params.acceptedSource?.kind === "worktree") {
      const source = getRegistryWorktree(process.env, params.acceptedSource.id);
      const root = fs.realpathSync(workspace);
      if (!source || source.ownerKind !== "session" || source.repoRoot !== root) {
        throw new SessionWorktreeSourceChangedError(
          "Accepted managed source is no longer available",
        );
      }
      const assertCurrent = () => {
        commitGuard?.();
        const current = getRegistryWorktree(process.env, source.id);
        if (
          current?.ownerId !== source.ownerId ||
          current?.repoRoot !== root ||
          current?.repoFingerprint !== source.repoFingerprint ||
          fs.realpathSync(workspace) !== root
        ) {
          throw new SessionWorktreeSourceChangedError(
            "Accepted managed source changed during preparation",
          );
        }
      };
      // An archived parent retains this registry/snapshot owner. Its session is
      // no longer the child's authority once the locked creation accepted intent.
      withSource = async (run) => {
        assertCurrent();
        return await run({ assertCurrent, signal: params.signal });
      };
    }
    // Registry custody authorizes source-only preparation, not direct host access.
    // The resulting session is executed through its private sandbox projection.
    if (sandboxRequired && workspace && !withSource) {
      const projectId =
        target.projectId ??
        target.entry?.projectId ??
        (params.acceptedSource?.kind === "project" ? params.acceptedSource.id : undefined);
      const selected =
        projectId && !projectId.startsWith("workspace:")
          ? await selectStoredProjectRegistry(projectId, { signal: params.signal })
          : undefined;
      if (selected) {
        const expectedRoot = fs.realpathSync(workspace);
        withSource = async (run) =>
          await selected.withCurrent((current) => {
            const assertCurrent = () => {
              commitGuard?.();
              current.assertCurrent();
              if (
                !current.project ||
                current.project.repoRoot !== expectedRoot ||
                fs.realpathSync(workspace) !== expectedRoot
              ) {
                throw new SessionWorktreeSourceChangedError(
                  "Selected project changed during guest workspace preparation",
                );
              }
            };
            assertCurrent();
            return run({ ...current, assertCurrent });
          });
        withRollback = selected.withRollback;
      }
    }
    // Raw paths and workspace aliases retain the selected-agent boundary.
    if (sandboxRequired && workspace && !withSource) {
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
    await checkSource();
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
        return invalidSessionRequest("session worktree belongs to a different repository");
      }
      // Replaying the recorded selection reuses the checkout; changing it must not rebase it.
      if (
        (params.name && existing.name !== params.name) ||
        (params.baseRef && existing.baseRef !== params.baseRef)
      ) {
        return invalidSessionRequest(
          `session is already bound to worktree ${existing.name} (${existing.branch})`,
        );
      }
    }
    await checkSource();
    const createParams = {
      ownerKind: "session" as const,
      ownerId: target.key,
      name: params.name,
      suggestedName: slugifyWorktreeTitle(params.label ?? ""),
      signal: params.signal,
      commitGuard,
      withSource,
      withRollback,
      onProgress: params.onProgress,
    };
    const { record: worktree, materialized } = workspace
      ? await managedWorktrees.createWithOutcome({
          ...createParams,
          repoRoot: workspace,
          baseRef: params.baseRef,
          checkoutCommit: params.checkoutCommit,
          runSetupScript: sandboxRequired ? false : params.runSetupScript,
          provisionIgnoredFiles: !sandboxRequired,
        })
      : await managedWorktrees.createEmptyWithOutcome(createParams);
    const rollback = materialized
      ? async () => await managedWorktrees.rollbackPreparation(worktree, withRollback)
      : undefined;
    const accept = (
      assertSourceCurrent?: () => void,
    ): Result<PreparedGatewaySessionLifecycle, ErrorShape> => {
      commitGuard?.();
      assertSourceCurrent?.();
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
        ...(withSource
          ? {
              withCommit: async <T>(run: (assertCurrent: () => void) => Promise<T>) =>
                await withSource!((current) => run(current.assertCurrent)),
            }
          : {}),
      });
    };
    try {
      return withSource ? await withSource((current) => accept(current.assertCurrent)) : accept();
    } catch (error) {
      const failures = [error];
      try {
        await rollback?.();
      } catch (cleanupError) {
        failures.push(cleanupError);
      }
      if (failures.length > 1) {
        throw new AggregateError(
          failures,
          `${formatErrorMessage(error)}; worktree cleanup failed: ${formatErrorMessage(failures[1])}`,
          { cause: error },
        );
      }
      throw error;
    }
  } catch (error) {
    // Closed delegated authority remains an exception for its admission owner.
    commitGuard?.();
    if (
      collectNestedErrorCandidates(error).some(
        (cause) => cause instanceof SessionWorktreeSourceChangedError,
      )
    ) {
      throw error;
    }
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

/** Select and prepare worktree intent while the existing session lifecycle owns the target. */
export async function prepareSessionWorktreeCreation(params: {
  cfg: OpenClawConfig;
  target: Parameters<PrepareGatewaySessionLifecycle>[0];
  workspace?: string | { kind: "empty" };
  inheritParentKey?: string;
  projectGitUrl?: string;
  name?: string;
  baseRef?: string;
  deferWorktree: boolean;
  label?: string;
  titleSource: string;
  currentUserMessage?: string;
  useRequestedTitleSelection: boolean;
  runSetupScript: boolean;
  signal?: AbortSignal;
  commitGuard: () => void;
  onTitleError: (error: unknown) => void;
  onTitlePersisted: () => void;
}): ReturnType<PrepareGatewaySessionLifecycle> {
  const { cfg, target: lifecycleTarget, signal, commitGuard } = params;
  commitGuard();
  const acceptedWorktree = params.inheritParentKey ? lifecycleTarget.entry?.worktree : undefined;
  const acceptedPending = params.inheritParentKey
    ? lifecycleTarget.entry?.pendingWorktree
    : undefined;
  if (acceptedPending && !acceptedPending.workspace) {
    if (lifecycleTarget.entry?.pendingProjectGitUrl) {
      // The admitted first-turn owner materializes this child's recorded clone intent.
      return { ok: true, value: {} };
    }
    return {
      ok: false,
      error: errorShape(
        ErrorCodes.UNAVAILABLE,
        "Saved worktree workspace is invalid; select the repository and retry.",
      ),
    };
  }
  const inheritedSource =
    params.inheritParentKey && !acceptedWorktree && !acceptedPending
      ? await resolveSpawnParentWorktreeSource(params.inheritParentKey, lifecycleTarget.agentId, {
          signal,
        })
      : undefined;
  commitGuard();
  const withSource = inheritedSource?.withCurrent;
  const withCommit: PreparedGatewaySessionLifecycle["withCommit"] = withSource
    ? async (run) =>
        await withSource((current) => {
          current.assertCurrent();
          return run(current.assertCurrent);
        })
    : undefined;
  const workspace =
    params.workspace ??
    acceptedWorktree?.canonicalWorkspaceDir ??
    acceptedWorktree?.repoRoot ??
    acceptedPending?.workspace ??
    inheritedSource?.workspace ??
    resolveAgentWorkspaceDir(cfg, lifecycleTarget.agentId);
  const name = params.name;
  const baseRef = params.baseRef;
  if (withSource) {
    await withSource((current) => {
      commitGuard();
      current.assertCurrent();
    });
  }
  // Git discovery permits subdirectory workspaces with an ancestor .git entry.
  if (typeof workspace === "string" && !params.projectGitUrl && !insideGitCheckout(workspace)) {
    return invalidSessionRequest("agent workspace is not a git checkout");
  }
  // Reuse validates the binding, not a selected ref that may have since disappeared.
  const resolvedBase =
    typeof workspace === "string" &&
    baseRef &&
    !params.projectGitUrl &&
    !lifecycleTarget.entry?.worktree
      ? withSource
        ? await withSource((current) =>
            resolveSessionWorktreeBase(workspace, baseRef, signal, () => {
              commitGuard();
              current.assertCurrent();
            }),
          )
        : await resolveSessionWorktreeBase(workspace, baseRef, signal, commitGuard)
      : undefined;
  if (resolvedBase && !resolvedBase.ok) {
    return resolvedBase;
  }
  const baseCommit = resolvedBase?.value;
  if (params.deferWorktree && typeof workspace === "string") {
    // Persist intent before setup so the admitted turn can retry in this session.
    return {
      ok: true,
      value: {
        withCommit,
        pendingWorktree: {
          ...(params.projectGitUrl ? {} : { workspace }),
          ...(inheritedSource?.source || acceptedPending?.source
            ? { source: inheritedSource?.source ?? acceptedPending?.source }
            : {}),
          name,
          baseRef,
          baseCommit,
          titleSource: params.titleSource,
        },
      },
    };
  }
  const source = params.titleSource;
  // Empty creates have no persisted generation until the lifecycle owner commits.
  const title =
    !name && !params.label && lifecycleTarget.entry && lifecycleTarget.titleModelSelection !== null
      ? await generateWorktreeSessionTitle({
          cfg,
          agentId: lifecycleTarget.agentId,
          // Pre-commit naming uses the saved account until this chat owns a new selection.
          entry: params.useRequestedTitleSelection
            ? { ...lifecycleTarget.entry, ...lifecycleTarget.titleModelSelection }
            : lifecycleTarget.entry,
          sessionId: lifecycleTarget.entry.sessionId,
          sessionKey: lifecycleTarget.key,
          storePath: lifecycleTarget.storePath,
          currentUserMessage: params.currentUserMessage,
          userMessage: source,
          commitGuard,
          withSource,
          onError: params.onTitleError,
          onPersisted: params.onTitlePersisted,
        })
      : undefined;
  const prepared = await prepareSessionWorktree({
    cfg,
    target: lifecycleTarget,
    workspace,
    name,
    baseRef,
    checkoutCommit: baseCommit,
    label: params.label ?? title ?? resolveExplicitSessionName(lifecycleTarget.entry),
    runSetupScript: params.runSetupScript,
    signal,
    commitGuard,
    withSource,
    withRollback: inheritedSource?.withRollback,
  });
  if (prepared.ok) {
    return { ok: true, value: { ...prepared.value, ...(withCommit ? { withCommit } : {}) } };
  }
  return prepared;
}

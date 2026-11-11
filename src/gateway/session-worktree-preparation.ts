import fs from "node:fs";
import path from "node:path";
import { collectNestedErrorCandidates } from "@openclaw/normalization-core/error-coercion";
import { err, ok, type Result } from "@openclaw/normalization-core/result";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  type ErrorShape,
} from "../../packages/gateway-protocol/src/index.js";
import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { resolveSandboxRuntimeStatus } from "../agents/sandbox/runtime-status.js";
import {
  withWorktreeSourceWait,
  WORKTREE_CREATE_LEASE_WAIT_MS,
} from "../agents/worktrees/allocation.js";
import { InvalidWorktreeBaseRefError, resolveWorktreeBase } from "../agents/worktrees/base-ref.js";
import { SessionWorktreeSourceChangedError } from "../agents/worktrees/errors.js";
import { insideGitCheckout } from "../agents/worktrees/git.js";
import { slugifyWorktreeTitle } from "../agents/worktrees/name.js";
import {
  captureWorktreeRegistryReadGuard,
  readRegistryWorktree,
  readSessionWorktreeBinding,
} from "../agents/worktrees/registry-read.js";
import { resolveRepositoryPaths } from "../agents/worktrees/repository-paths.js";
import { captureWorktreeRunEndContext } from "../agents/worktrees/run-end-lifecycle.js";
import { ManagedWorktreeService, WorktreeRepositoryError } from "../agents/worktrees/service.js";
import type {
  CreateManagedWorktreeParams,
  WorktreeSourceStage,
  WorktreeWaitBudget,
} from "../agents/worktrees/types.js";
import {
  composeSessionSourceAssertion,
  type SessionSourceAssertion,
} from "../config/sessions/session-source-authority.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { hasInternalHookListeners } from "../hooks/internal-hooks.js";
import { formatErrorMessage } from "../infra/errors.js";
import { listWorkspaceProjects } from "../projects/project-registry.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { getSessionRepositoryWorkspaceStore } from "../state/session-repository-workspaces.js";
import { generateWorktreeSessionTitle } from "./dashboard-session-title.js";
import {
  canRequesterUseRepositoryUrl,
  hasFullProjectAccess,
  type ProjectRequester,
  resolveRequesterProject,
} from "./project-access.js";
import { prepareSessionCreateFilesystemRoot } from "./server-methods/session-create-root.js";
import type {
  PrepareGatewaySessionLifecycle,
  PreparedGatewaySessionLifecycle,
} from "./session-create-service.types.js";
import {
  resolveSessionProjectRootForRecord,
  resolveSpawnParentWorktreeSource,
  type SpawnParentWorktreeSource,
  selectSessionWorktreeProjectSource,
} from "./session-project-source.js";
import { prepareSessionRepositoryWorkspace } from "./session-repository-preparation.js";
import { invalidSessionRequest, nonGitWorktreeSourceMessage } from "./session-request-error.js";
import { resolveExplicitSessionName } from "./session-title-state.js";
import {
  createSessionWorktreeBinding,
  prepareSessionWorktreeCwd,
} from "./session-worktree-binding.js";
import type { createRepositoryWorkspaceMutationService } from "./worker-environments/repository-workspace-mutation.js";
import { forkSessionRepositoryWorkspace } from "./worker-environments/session-repository-checkpoints.js";

/**
 * Resolve registered sources identically for dashboard and native child sessions.
 * This hands out source, so restricted requesters get a fresh visibility answer.
 */
export async function resolveSessionProjectRoot(
  cfg: OpenClawConfig,
  projectId: string,
  worktree: boolean,
  requester: ProjectRequester,
): Promise<Result<string, ErrorShape>> {
  const project = await resolveRequesterProject(cfg, projectId, requester, { fresh: true });
  if (!project) {
    return invalidSessionRequest(`unknown project id: ${projectId}`);
  }
  return resolveSessionProjectRootForRecord(project, worktree);
}

type AcceptedWorktreeSource = NonNullable<
  PreparedGatewaySessionLifecycle["pendingWorktree"]
>["source"];

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
  waitBudget?: WorktreeWaitBudget;
  acceptedSource?: AcceptedWorktreeSource;
  withRollback?: SpawnParentWorktreeSource["withRollback"];
  onProgress?: CreateManagedWorktreeParams["onProgress"];
  onPromptReady?: (prepared: PreparedGatewaySessionLifecycle) => Promise<void>;
}): ReturnType<PrepareGatewaySessionLifecycle> {
  const { target, commitGuard } = params;
  const waitBudget = params.waitBudget ?? { remainingMs: WORKTREE_CREATE_LEASE_WAIT_MS };
  const context = captureWorktreeRunEndContext(process.env);
  const env = { ...process.env, ...context.environment };
  const worktrees = new ManagedWorktreeService({ env, getConfig: () => params.cfg });
  const sandboxRequired =
    target.sandboxRequired === true ||
    target.entry?.sandbox === "required" ||
    resolveSandboxRuntimeStatus({
      cfg: params.cfg,
      agentId: target.agentId,
      sessionKey: target.key,
      preparedSessionEntry: target.entry ?? null,
    }).sandboxed;
  let withSource = params.withSource;
  let withRollback = params.withRollback;
  const checkSource = async () => {
    commitGuard?.();
    if (withSource) {
      await withWorktreeSourceWait(withSource, waitBudget, (current) => {
        commitGuard?.();
        current.assertCurrent();
      });
    }
  };
  try {
    await checkSource();
    const workspace = typeof params.workspace === "string" ? params.workspace : undefined;
    if (sandboxRequired && workspace && !withSource && params.acceptedSource?.kind === "worktree") {
      const accept = captureWorktreeRegistryReadGuard(context, "source-record");
      const source = await readRegistryWorktree(context, params.acceptedSource.id);
      const assertSourceCurrent = accept(source);
      commitGuard?.();
      const root = fs.realpathSync(workspace);
      if (!source || source.ownerKind !== "session" || source.repoRoot !== root) {
        throw new SessionWorktreeSourceChangedError(
          "Accepted managed source is no longer available",
        );
      }
      const assertHostCurrent = () => {
        commitGuard?.();
        if (fs.realpathSync(workspace) !== root) {
          throw new SessionWorktreeSourceChangedError(
            "Accepted managed source changed during preparation",
          );
        }
      };
      const assertCurrent = () => {
        assertHostCurrent();
        assertSourceCurrent();
      };
      // An archived parent retains this registry/snapshot owner. Its session is
      // no longer the child's authority once the locked creation accepted intent.
      withSource = async (run) => {
        assertCurrent();
        return await run({
          assertCurrent,
          signal: params.signal,
          workerAuthority: {
            assertCurrent: assertHostCurrent,
            predicates: [
              {
                kind: "source-record",
                id: source.id,
                ownerId: source.ownerId,
                repoRoot: root,
                repoFingerprint: source.repoFingerprint,
              },
            ],
          },
        });
      };
    }
    // Registry custody authorizes source-only preparation, not direct host access.
    // Requester visibility (project-access.ts) is enforced when the session, spawn
    // or inherited child is created; this admitted turn only materializes that choice.
    // The resulting session is executed through its private sandbox projection.
    if (sandboxRequired && workspace && !withSource) {
      const projectId =
        target.projectId ??
        target.entry?.projectId ??
        (params.acceptedSource?.kind === "project" ? params.acceptedSource.id : undefined);
      const selected = await selectSessionWorktreeProjectSource(projectId, params.signal);
      if (selected) {
        const expectedRoot = fs.realpathSync(workspace);
        withSource = async (run, acquisition) =>
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
          }, acquisition);
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
    const boundId = normalizeOptionalString(target.entry?.worktree?.id);
    const existing = await readSessionWorktreeBinding(context, boundId, target.key);
    commitGuard?.();
    // New allocations return their source root; reuse and early prompts need it beforehand.
    const repository =
      workspace && (existing || params.onPromptReady)
        ? await resolveRepositoryPaths(workspace)
        : undefined;
    await checkSource();
    if (existing && (existing.ownerKind !== "session" || existing.ownerId !== target.key)) {
      return err(
        errorShape(ErrorCodes.UNAVAILABLE, "session worktree binding has a different owner"),
      );
    }
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
      waitBudget,
      withRollback,
      onProgress: params.onProgress,
      // Sandboxes require a published registry owner before creating their projection.
      // Nested cwd discovery also retains complete checkout as its prompt boundary.
      ...(params.onPromptReady &&
      !sandboxRequired &&
      // Bootstrap hooks can read configured or custom paths outside the prepared files.
      !hasInternalHookListeners("agent", "bootstrap") &&
      repository &&
      workspace === repository.sourceRoot
        ? {
            onPromptReady: async (
              worktree: Parameters<NonNullable<CreateManagedWorktreeParams["onPromptReady"]>>[0],
            ) => {
              commitGuard?.();
              await params.onPromptReady!({
                spawnedCwd: worktree.path,
                sessionRoot: worktree.path,
                worktree: createSessionWorktreeBinding(worktree, workspace),
              });
              commitGuard?.();
            },
          }
        : {}),
    };
    const {
      record: worktree,
      materialized,
      sourceRoot,
    } = workspace
      ? await worktrees.createWithOutcome({
          ...createParams,
          repoRoot: workspace,
          baseRef: params.baseRef,
          checkoutCommit: params.checkoutCommit,
          runSetupScript: sandboxRequired ? false : params.runSetupScript,
          provisionIgnoredFiles: !sandboxRequired,
        })
      : { ...(await worktrees.createEmptyWithOutcome(createParams)), sourceRoot: undefined };
    const rollback = materialized
      ? async () => await worktrees.rollbackPreparation(worktree, withRollback)
      : undefined;
    const accept = (
      assertSourceCurrent?: () => void,
    ): Result<PreparedGatewaySessionLifecycle, ErrorShape> => {
      commitGuard?.();
      assertSourceCurrent?.();
      return ok({
        spawnedCwd: prepareSessionWorktreeCwd(worktree.path, sourceRoot, workspace),
        sessionRoot: fs.realpathSync(worktree.path),
        worktree: createSessionWorktreeBinding(
          worktree,
          workspace ?? worktree.repoRoot,
          target.entry?.worktree,
        ),
        ...(rollback ? { rollback } : {}),
        ...(withSource
          ? {
              withCommit: async <T>(
                run: (assertCurrent: SessionSourceAssertion, signal?: AbortSignal) => Promise<T>,
              ) =>
                await withWorktreeSourceWait(withSource!, waitBudget, (current) =>
                  run(current.assertCurrent, current.signal),
                ),
            }
          : {}),
      });
    };
    try {
      return withSource
        ? await withWorktreeSourceWait(withSource, waitBudget, (current) =>
            accept(current.assertCurrent),
          )
        : accept();
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

async function canRequesterInheritParentSource(
  cfg: OpenClawConfig,
  source: NonNullable<Awaited<ReturnType<typeof resolveSpawnParentWorktreeSource>>>,
  requester: ProjectRequester,
): Promise<boolean> {
  if (hasFullProjectAccess(requester)) {
    return true;
  }
  if (source.kind === "repository") {
    return await canRequesterUseRepositoryUrl(cfg, source.repository.url, requester, {
      fresh: true,
    });
  }
  if (source.projectId) {
    return (
      (await resolveRequesterProject(cfg, source.projectId, requester, { fresh: true })) !==
      undefined
    );
  }
  // A cwd-based worktree has no registry identity; only an agent workspace (a
  // workspace pseudo-project, governed by roles.agents) is allowed.
  const root = path.resolve(source.workspace);
  return listWorkspaceProjects(cfg).some((project) => path.resolve(project.repoRoot) === root);
}

/** Select and prepare worktree intent while the existing session lifecycle owns the target. */
export async function prepareSessionWorktreeCreation(params: {
  cfg: OpenClawConfig;
  target: Parameters<PrepareGatewaySessionLifecycle>[0];
  workspace?: string | { kind: "empty" };
  inheritParentKey?: string;
  /** Inherited children receive the parent's source, so the child's requester must reach it. */
  projectRequester: ProjectRequester;
  repositoryMutations?: Pick<ReturnType<typeof createRepositoryWorkspaceMutationService>, "fork">;
  projectGitUrl?: string;
  name?: string;
  baseRef?: string;
  deferWorktree: boolean;
  hasInitialTurn?: boolean;
  label?: string;
  titleSource: string;
  currentUserMessage?: string;
  useRequestedTitleSelection: boolean;
  runSetupScript: boolean;
  signal?: AbortSignal;
  commitGuard: () => void;
  onTitleError: (error: unknown) => void;
  onTitleStateChanged: () => void;
}): ReturnType<PrepareGatewaySessionLifecycle> {
  const { cfg, target: lifecycleTarget, signal, commitGuard, name, baseRef } = params;
  const waitBudget = { remainingMs: WORKTREE_CREATE_LEASE_WAIT_MS };
  commitGuard();
  const acceptedWorktree = params.inheritParentKey ? lifecycleTarget.entry?.worktree : undefined;
  const acceptedPending = params.inheritParentKey
    ? lifecycleTarget.entry?.pendingWorktree
    : undefined;
  if (acceptedPending && !acceptedPending.workspace) {
    if (lifecycleTarget.entry?.pendingProjectGitUrl) {
      // The admitted first-turn owner materializes this child's recorded clone intent.
      return ok({});
    }
    return err(
      errorShape(
        ErrorCodes.UNAVAILABLE,
        "Saved worktree workspace is invalid; select the repository and retry.",
      ),
    );
  }
  const parentSource =
    params.inheritParentKey &&
    !acceptedWorktree &&
    !acceptedPending &&
    !lifecycleTarget.entry?.repositoryWorkspaceId
      ? await resolveSpawnParentWorktreeSource(params.inheritParentKey, lifecycleTarget.agentId, {
          signal,
        })
      : undefined;
  if (
    parentSource &&
    !(await canRequesterInheritParentSource(cfg, parentSource, params.projectRequester))
  ) {
    return invalidSessionRequest(
      "The parent session's project is not available to this requester.",
    );
  }
  commitGuard();
  if (parentSource?.kind === "repository") {
    if (name || baseRef) {
      return invalidSessionRequest(
        "Inherited repository helpers use the accepted base; omit worktreeName and worktreeBaseRef.",
      );
    }
    if (params.hasInitialTurn || params.deferWorktree) {
      return invalidSessionRequest(
        "Create the repository helper without an initial turn, dispatch it with sessions.dispatch, then send the message with sessions.send.",
      );
    }
    const { repository } = parentSource;
    const assertCurrent = composeSessionSourceAssertion(
      [parentSource.assertCurrent],
      (assertSources) => {
        commitGuard();
        assertSources();
      },
    );
    if (!repository.baseCommit && !repository.diskAuthority) {
      return await prepareSessionRepositoryWorkspace(
        {
          url: repository.url,
          ...(repository.requestedRef ? { ref: repository.requestedRef } : {}),
        },
        {
          branchPrefix: cfg.repositoryBranchPrefix,
          runSetupScript: repository.runSetupScript && params.runSetupScript,
          assertCurrent,
        },
      )(lifecycleTarget);
    }
    const store = getSessionRepositoryWorkspaceStore();
    const source = captureOpenClawStateWorkerContext({ path: store.path });
    const target = { agentId: lifecycleTarget.agentId, sessionKey: lifecycleTarget.key };
    const options = {
      branchPrefix: cfg.repositoryBranchPrefix,
      runSetupScript: params.runSetupScript,
      assertCurrent,
    };
    if (repository.diskAuthority && !params.repositoryMutations) {
      return err(
        errorShape(
          ErrorCodes.UNAVAILABLE,
          "Repository child export is unavailable; reconnect the original disk and retry.",
        ),
      );
    }
    const workspace = repository.diskAuthority
      ? await params.repositoryMutations!.fork({
          ...options,
          target,
          repository,
          sessionId: parentSource.sessionId,
          agentId: repository.agentId,
          sessionKey: repository.sessionKey,
        })
      : await forkSessionRepositoryWorkspace({
          ...options,
          ...target,
          store,
          sourceWorkspaceId: repository.workspaceId,
        });
    return ok({
      repositoryWorkspaceId: workspace.workspaceId,
      withCommit: (run) => run(assertCurrent, signal),
      rollback: () =>
        store.delete({
          workspaceId: workspace.workspaceId,
          assertCurrent: () => source.admission.assertCurrent(),
        }),
    });
  }
  const inheritedSource = parentSource;
  const withSource = inheritedSource?.withCurrent;
  const withCommit: PreparedGatewaySessionLifecycle["withCommit"] = withSource
    ? async (run) =>
        await withWorktreeSourceWait(withSource, waitBudget, (current) => {
          current.assertCurrent();
          return run(current.assertCurrent, current.signal);
        })
    : undefined;
  const workspace =
    params.workspace ??
    acceptedWorktree?.canonicalWorkspaceDir ??
    acceptedWorktree?.repoRoot ??
    acceptedPending?.workspace ??
    inheritedSource?.workspace ??
    resolveAgentWorkspaceDir(cfg, lifecycleTarget.agentId);
  if (withSource) {
    await withWorktreeSourceWait(withSource, waitBudget, (current) => {
      commitGuard();
      current.assertCurrent();
    });
  }
  // Git discovery permits subdirectory workspaces with an ancestor .git entry.
  if (typeof workspace === "string" && !params.projectGitUrl && !insideGitCheckout(workspace)) {
    return invalidSessionRequest(nonGitWorktreeSourceMessage(params.workspace));
  }
  // Reuse validates the binding, not a selected ref that may have since disappeared.
  const resolvedBase =
    typeof workspace === "string" &&
    baseRef &&
    !params.projectGitUrl &&
    !lifecycleTarget.entry?.worktree
      ? withSource
        ? await withWorktreeSourceWait(withSource, waitBudget, (current) =>
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
          userMessage: params.titleSource,
          commitGuard,
          withSource,
          waitBudget,
          onError: params.onTitleError,
          onTitleStateChanged: params.onTitleStateChanged,
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
    waitBudget,
    withRollback: inheritedSource?.withRollback,
  });
  return prepared.ok ? ok({ ...prepared.value, ...(withCommit ? { withCommit } : {}) }) : prepared;
}

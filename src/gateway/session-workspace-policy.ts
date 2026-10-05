import { err, ok, type Result } from "@openclaw/normalization-core/result";
import {
  ErrorCodes,
  errorShape,
  type ErrorShape,
  type SessionsCreateParams,
} from "../../packages/gateway-protocol/src/index.js";
import type { AdmittedRunOperatorAuthority } from "../agents/admitted-run-context.js";
import type { WorktreeSourceStage } from "../agents/worktrees/types.js";
import type { RequiredSessionWorkspace } from "../config/sessions/session-entry-provenance.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  resolveWorkspaceProject,
  selectStoredProjectRegistry,
} from "../projects/project-registry.js";
import type { PrepareGatewaySessionLifecycle } from "./session-create-service.types.js";
import {
  prepareSessionWorktree,
  resolveSessionWorktreeBase,
} from "./session-worktree-preparation.js";

export type OperatorWorkspacePolicy = NonNullable<
  NonNullable<AdmittedRunOperatorAuthority["rolePolicy"]>["workspace"]
>;

export const REQUIRED_WORKSPACE_MESSAGE =
  "Select an authorized workspace and start a new thread. This role requires a new managed worktree.";

/** A parent selection is explicit context; a default agent directory is not a selection. */
export function resolveRequiredSessionWorkspace(params: {
  policy?: OperatorWorkspacePolicy;
  inherited?: RequiredSessionWorkspace;
  projectId?: string;
}): Result<RequiredSessionWorkspace | undefined, ErrorShape> {
  const { policy, inherited } = params;
  if (!policy && !inherited) {
    return ok(undefined);
  }
  const projectId = params.projectId ?? inherited?.projectId;
  if (
    !projectId ||
    (inherited && inherited.projectId !== projectId) ||
    (policy && !policy.projects.includes(projectId))
  ) {
    return err(errorShape(ErrorCodes.FORBIDDEN, REQUIRED_WORKSPACE_MESSAGE));
  }
  if (policy && inherited && policy.worktreeBaseRef !== inherited.worktreeBaseRef) {
    return err(
      errorShape(
        ErrorCodes.FORBIDDEN,
        "Workspace policy changed. Select a workspace in a new thread.",
      ),
    );
  }
  return ok({ projectId, worktreeBaseRef: inherited?.worktreeBaseRef ?? policy!.worktreeBaseRef });
}

/** Public selectors cannot replace the thread's selected-project source or base. */
export function validateRequiredWorkspaceSelectors(
  params: SessionsCreateParams,
  policy: { worktreeBaseRef: string },
): ErrorShape | undefined {
  if (
    params.cwd ||
    params.execNode ||
    params.projectGitUrl ||
    params.repository ||
    params.catalogId ||
    params.incognito ||
    params.worktreeSource === "empty" ||
    params.worktree === false ||
    (params.worktreeBaseRef && params.worktreeBaseRef !== policy.worktreeBaseRef)
  ) {
    return errorShape(
      ErrorCodes.FORBIDDEN,
      "This thread requires its selected workspace and recorded worktree base. Remove custom paths, repository sources, and execution-node overrides.",
    );
  }
  return undefined;
}

/** The existing allocator owns checkout creation, source custody, commit, and rollback. */
export function prepareRequiredSessionWorkspace(params: {
  cfg: OpenClawConfig;
  getCurrentConfig: () => OpenClawConfig;
  required: RequiredSessionWorkspace;
  assertCurrent: () => void;
  signal?: AbortSignal;
}): PrepareGatewaySessionLifecycle {
  return async (target) => {
    params.assertCurrent();
    if (target.entry) {
      return err(errorShape(ErrorCodes.FORBIDDEN, REQUIRED_WORKSPACE_MESSAGE));
    }
    const selection = params.required.projectId.startsWith("workspace:")
      ? undefined
      : await selectStoredProjectRegistry(params.required.projectId, { signal: params.signal });
    const project =
      selection?.project ?? resolveWorkspaceProject(params.cfg, params.required.projectId);
    params.assertCurrent();
    if (!project) {
      return err(
        errorShape(
          ErrorCodes.UNAVAILABLE,
          "Selected workspace is unavailable. Select another authorized workspace or ask a maintainer to restore it.",
        ),
      );
    }
    // Resolve once for this allocation. Retrying the allocator cannot switch to a
    // newer base while the session owner is committing the prepared checkout.
    const withSource: WorktreeSourceStage = async (run) => {
      params.assertCurrent();
      if (selection) {
        return await selection.withCurrent((current) => {
          const assertCurrent = () => {
            params.assertCurrent();
            current.assertCurrent();
            if (current.project?.repoRoot !== project.repoRoot) {
              throw new Error(
                "Selected workspace changed before allocation. Retry with the current workspace.",
              );
            }
          };
          assertCurrent();
          return run({ ...current, assertCurrent });
        });
      }
      const assertCurrent = () => {
        params.assertCurrent();
        if (
          resolveWorkspaceProject(params.getCurrentConfig(), project.id)?.repoRoot !==
          project.repoRoot
        ) {
          throw new Error(
            "Selected workspace changed before allocation. Retry with the current workspace.",
          );
        }
      };
      assertCurrent();
      return await run({ assertCurrent, signal: params.signal });
    };
    const base = await withSource((current) =>
      resolveSessionWorktreeBase(
        project.repoRoot,
        params.required.worktreeBaseRef,
        current.signal,
        current.assertCurrent,
      ),
    );
    if (!base.ok) {
      return base;
    }
    return await prepareSessionWorktree({
      cfg: params.cfg,
      target: { ...target, projectId: project.id },
      workspace: project.repoRoot,
      baseRef: params.required.worktreeBaseRef,
      checkoutCommit: base.value,
      runSetupScript: false,
      requireNew: true,
      signal: params.signal,
      commitGuard: params.assertCurrent,
      withSource,
      withRollback: selection?.withRollback,
    });
  };
}

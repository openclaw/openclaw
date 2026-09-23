import fs from "node:fs";
import { err, ok, type Result } from "@openclaw/normalization-core/result";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  type ErrorShape,
  type SessionsCreateParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { resolveAgentWorkspaceDir } from "../../agents/agent-scope.js";
import { resolveSandboxRuntimeStatus } from "../../agents/sandbox/runtime-status.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { isPathInside } from "../../infra/path-guards.js";
import { resolveSessionWorkspaceRoots } from "../session-workspace-roots.js";

type PreparedSessionCreateRoot = {
  sessionCwd?: string;
  sessionRoot?: string;
};

export function prepareSessionCreateFilesystemRoot(params: {
  cfg: OpenClawConfig;
  requestedExecNode?: string;
  requestedProjectId?: string;
  enforceSandboxContainment: boolean;
  /** Effective requirement from the locked creation owner before the child is persisted. */
  sandboxRequired?: boolean;
  sessionCwd?: string;
  sessionKey?: string;
  targetAgentId: string;
}): Result<PreparedSessionCreateRoot, ErrorShape> {
  if (params.requestedExecNode) {
    return ok({ sessionCwd: params.sessionCwd });
  }
  try {
    const workspaceDir = resolveAgentWorkspaceDir(params.cfg, params.targetAgentId);
    const rootCandidate = params.sessionCwd ?? workspaceDir;
    if (!params.sessionCwd) {
      fs.mkdirSync(rootCandidate, { recursive: true });
    }
    const sessionRoot = fs.realpathSync(rootCandidate);
    if (!fs.statSync(sessionRoot).isDirectory()) {
      return err(errorShape(ErrorCodes.INVALID_REQUEST, "sessions.create cwd is not a directory"));
    }
    if (params.sessionCwd && params.enforceSandboxContainment) {
      const targetRuntime = resolveSandboxRuntimeStatus({
        cfg: params.cfg,
        agentId: params.targetAgentId,
        sessionKey: params.sessionKey ?? `agent:${params.targetAgentId}:dashboard:pending`,
      });
      // Canonical paths admit workspace aliases while rejecting links that
      // resolve outside the selected agent's workspace.
      if (
        (params.sandboxRequired || targetRuntime.sandboxed) &&
        !isPathInside(fs.realpathSync(workspaceDir), sessionRoot)
      ) {
        return err(
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            params.requestedProjectId
              ? "sessions.create project is outside the sandboxed agent workspace"
              : "sessions.create cwd is outside the sandboxed agent workspace",
          ),
        );
      }
    }
    return ok({ sessionRoot, sessionCwd: params.sessionCwd ? sessionRoot : undefined });
  } catch (error) {
    return err(
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        `sessions.create cwd is unavailable: ${formatErrorMessage(error)}`,
      ),
    );
  }
}

/** Keep an implicit Gateway default distinct from a caller-selected fork destination. */
export function resolveSessionCreateRootParameters(
  params: Pick<SessionsCreateParams, "cwd" | "projectId" | "fork" | "worktree">,
  root: PreparedSessionCreateRoot | undefined,
) {
  if (params.worktree === true) {
    return {};
  }
  const inheritsParent =
    params.fork === true &&
    !normalizeOptionalString(params.cwd) &&
    !normalizeOptionalString(params.projectId);
  return {
    spawnedCwd: root?.sessionCwd,
    sessionRoot: inheritsParent ? undefined : root?.sessionRoot,
    defaultSessionRoot: root?.sessionRoot,
  };
}

/** Reuse local workspace selections without inheriting managed or remote ownership. */
export function prepareSessionForkFilesystemRoot(params: {
  cfg: OpenClawConfig;
  parent: InternalSessionEntry;
  targetAgentId: string;
  sessionKey: string;
  sandboxRequired?: boolean;
}): Result<
  Pick<InternalSessionEntry, "projectId" | "spawnedCwd" | "spawnedWorkspaceDir" | "sessionRoot">,
  ErrorShape
> {
  const parent = params.parent;
  if (
    parent.worktree ||
    parent.repositoryWorkspaceId ||
    parent.execHost === "node" ||
    parent.execNode ||
    parent.pendingWorktree ||
    parent.pendingProjectGitUrl ||
    (!parent.spawnedCwd && !parent.spawnedWorkspaceDir)
  ) {
    return ok({});
  }
  const roots = resolveSessionWorkspaceRoots(params.cfg, params.targetAgentId, parent);
  const cwd = prepareSessionCreateFilesystemRoot({
    ...params,
    enforceSandboxContainment: true,
    requestedProjectId: parent.projectId,
    sessionCwd: roots.diffCwd,
  });
  if (!cwd.ok) {
    return cwd;
  }
  const root =
    roots.root === roots.diffCwd
      ? cwd
      : prepareSessionCreateFilesystemRoot({
          ...params,
          enforceSandboxContainment: true,
          requestedProjectId: parent.projectId,
          sessionCwd: roots.root,
        });
  if (!root.ok) {
    return root;
  }
  return ok({
    ...(parent.projectId ? { projectId: parent.projectId } : {}),
    spawnedCwd: cwd.value.sessionCwd,
    ...(parent.spawnedWorkspaceDir ? { spawnedWorkspaceDir: root.value.sessionRoot } : {}),
    sessionRoot: root.value.sessionRoot,
  });
}

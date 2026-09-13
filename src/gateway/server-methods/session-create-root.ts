import fs from "node:fs";
import { err, ok, type Result } from "@openclaw/normalization-core/result";
import {
  ErrorCodes,
  errorShape,
  type ErrorShape,
} from "../../../packages/gateway-protocol/src/index.js";
import { resolveAgentWorkspaceDir } from "../../agents/agent-scope.js";
import {
  isVerifiedSandboxMountRootHandoff,
  type SandboxMountRootHandoff,
} from "../../agents/sandbox/mount-root-handoff.js";
import { resolveSandboxRuntimeStatus } from "../../agents/sandbox/runtime-status.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { isPathInside } from "../../infra/path-guards.js";

type PreparedSessionCreateRoot = {
  sessionCwd?: string;
  sessionRoot?: string;
};

export function prepareSessionCreateFilesystemRoot(params: {
  cfg: OpenClawConfig;
  requestedExecNode?: string;
  requestedProjectId?: string;
  enforceSandboxContainment: boolean;
  /** In-process marker from the sandbox cwd mapping layer; see mount-root-handoff. */
  sandboxMountRootHandoff?: SandboxMountRootHandoff;
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
      const workspaceRoot = fs.realpathSync(workspaceDir);
      // Canonical paths admit workspace aliases while rejecting links that
      // resolve outside the selected agent's workspace. Only the sandbox cwd
      // mapping layer may hand over a root the sandbox itself mounts (an isolated
      // workspace copy or a bind target): its marker names that root, and the
      // sandbox layer re-derives it for this agent here, so unmarked callers keep
      // the original containment check.
      if (
        targetRuntime.sandboxed &&
        !isPathInside(workspaceRoot, sessionRoot) &&
        !isVerifiedSandboxMountRootHandoff({
          cfg: params.cfg,
          agentId: params.targetAgentId,
          hostPath: sessionRoot,
          handoff: params.sandboxMountRootHandoff,
        })
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

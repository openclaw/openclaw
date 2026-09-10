import fs from "node:fs";
import { err, ok, type Result } from "@openclaw/normalization-core/result";
import {
  ErrorCodes,
  errorShape,
  type ErrorShape,
} from "../../../packages/gateway-protocol/src/index.js";
import { resolveAgentWorkspaceDir } from "../../agents/agent-scope.js";
import { resolveSandboxRuntimeStatus } from "../../agents/sandbox/runtime-status.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { isWindowsDrivePath } from "../../infra/archive-path.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { isPathInside } from "../../infra/path-guards.js";

type PreparedSessionCreateRoot = {
  sessionCwd?: string;
  sessionRoot?: string;
};

/**
 * A sandboxed agent works inside a container, so a path it reports is relative to the
 * container mount namespace, not the Gateway host. `/workspace` is the Docker workdir and
 * can never exist here; without this check the host probes it and fails with a raw ENOENT
 * (`cwd is unavailable: lstat '/workspace'`), which reads like a broken install instead of
 * a path that belongs to another filesystem.
 *
 * Only the shape is judged here. Host-owned paths that are genuinely missing must keep
 * failing through the existing probe so a dangling workspace link still reports unavailable.
 * Native host paths are platform-absolute or Windows drive paths (`C:\...` is not
 * `path.isAbsolute` under POSIX rules, hence the second clause).
 */
function isContainerOnlyPath(raw: string): boolean {
  return raw.startsWith("/") && !isWindowsDrivePath(raw) && !raw.startsWith("//");
}

export function prepareSessionCreateFilesystemRoot(params: {
  cfg: OpenClawConfig;
  requestedExecNode?: string;
  requestedProjectId?: string;
  enforceSandboxContainment: boolean;
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
    // Classify before probing the host filesystem: only the sandbox branch below knows
    // whether a container path is plausible, so resolve the runtime first when a cwd
    // was requested. Doing this after `realpathSync` would let the raw ENOENT win.
    const sandboxRuntime =
      params.sessionCwd && params.enforceSandboxContainment
        ? resolveSandboxRuntimeStatus({
            cfg: params.cfg,
            agentId: params.targetAgentId,
            sessionKey: params.sessionKey ?? `agent:${params.targetAgentId}:dashboard:pending`,
          })
        : undefined;
    if (sandboxRuntime?.sandboxed && isContainerOnlyPath(rootCandidate)) {
      return err(
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `sessions.create cwd is a container path that does not exist on the Gateway host: ${rootCandidate}`,
        ),
      );
    }
    if (!params.sessionCwd) {
      fs.mkdirSync(rootCandidate, { recursive: true });
    }
    const sessionRoot = fs.realpathSync(rootCandidate);
    if (!fs.statSync(sessionRoot).isDirectory()) {
      return err(errorShape(ErrorCodes.INVALID_REQUEST, "sessions.create cwd is not a directory"));
    }
    if (params.sessionCwd && sandboxRuntime) {
      // Canonical paths admit workspace aliases while rejecting links that
      // resolve outside the selected agent's workspace.
      if (sandboxRuntime.sandboxed && !isPathInside(fs.realpathSync(workspaceDir), sessionRoot)) {
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

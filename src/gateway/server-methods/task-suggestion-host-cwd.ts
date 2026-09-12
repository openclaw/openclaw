// Host-path resolution for task suggestion cwd values recorded inside sandboxes.
import fs from "node:fs";
import {
  ErrorCodes,
  errorShape,
  type ErrorShape,
} from "../../../packages/gateway-protocol/src/index.js";
import { resolveAgentWorkspaceDir } from "../../agents/agent-scope.js";
import { ensureSandboxWorkspaceForSession } from "../../agents/sandbox/context.js";
import {
  buildSandboxFsMounts,
  resolveSandboxFsPathWithMounts,
} from "../../agents/sandbox/fs-paths.js";
import type { SandboxWorkspaceInfo } from "../../agents/sandbox/types.js";
import { resolveIngressWorkspaceOverrideForSessionRun } from "../../agents/spawned-context.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { loadGatewaySessionEntryReadOnly } from "../session-utils.js";

function isExistingHostDirectory(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

function unavailableTaskSuggestionCwdError(params: {
  cwd: string;
  mappedHostCwd?: string;
  hostWorkspaceDir: string;
  containerWorkdir?: string;
}): ErrorShape {
  const unresolved = params.mappedHostCwd
    ? `${params.cwd} maps to ${params.mappedHostCwd} in the sandbox workspace, but that path is missing on the host`
    : `${params.cwd} is missing on the host`;
  const hint = params.containerWorkdir
    ? `use a host path under ${params.hostWorkspaceDir} or a container path under ${params.containerWorkdir}`
    : `use a host path under ${params.hostWorkspaceDir}`;
  return errorShape(
    ErrorCodes.INVALID_REQUEST,
    `task suggestion cwd is unavailable: ${unresolved}; sandboxed sessions run in a container, so ${hint}.`,
  );
}

/**
 * The workspace a session actually runs in, which a spawned run or a dashboard
 * session opened on a selected folder or managed worktree pins away from the
 * agent's configured workspace. Sandbox setup mounts this one, so resolving the
 * container path against anything else points at the wrong checkout.
 */
function resolveSessionWorkspaceDir(params: {
  sessionKey: string;
  agentId: string;
}): string | undefined {
  try {
    const entry = loadGatewaySessionEntryReadOnly(params.sessionKey, {
      agentId: params.agentId,
    }).entry;
    return resolveIngressWorkspaceOverrideForSessionRun({
      spawnedBy: entry?.spawnedBy,
      workspaceDir: entry?.spawnedWorkspaceDir,
      cwd: entry?.spawnedCwd,
    });
  } catch {
    // An unreadable store leaves the configured agent workspace in charge.
    return undefined;
  }
}

/**
 * Map a recorded cwd onto the host directory the sandbox mounts there. The
 * mount table owns precedence (nested binds beat the workspace root) and
 * containment, so a path outside every mount stays unresolved instead of being
 * guessed from a container prefix.
 */
function mapCwdThroughSandboxMounts(params: {
  sandbox: SandboxWorkspaceInfo;
  containerWorkdir: string;
  cwd: string;
}): string | undefined {
  const mounts = buildSandboxFsMounts({
    workspaceDir: params.sandbox.workspaceDir,
    agentWorkspaceDir: params.sandbox.agentWorkspaceDir ?? params.sandbox.workspaceDir,
    ...(params.sandbox.skillsWorkspaceDir
      ? { skillsWorkspaceDir: params.sandbox.skillsWorkspaceDir }
      : {}),
    ...(params.sandbox.readOnlyResourceMounts
      ? { readOnlyResourceMounts: params.sandbox.readOnlyResourceMounts }
      : {}),
    workspaceAccess: params.sandbox.workspaceAccess ?? "ro",
    containerName: "",
    containerWorkdir: params.containerWorkdir,
    docker: params.sandbox.dockerBinds ? { binds: [...params.sandbox.dockerBinds] } : {},
  });
  try {
    return resolveSandboxFsPathWithMounts({
      filePath: params.cwd,
      cwd: params.containerWorkdir,
      defaultWorkspaceRoot: params.sandbox.workspaceDir,
      defaultContainerRoot: params.containerWorkdir,
      mounts,
    }).hostPath;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the host directory a recorded cwd refers to. Sandboxed sessions see
 * container paths, so translate through the source session's effective
 * workspace and mounts; every other session keeps host cwd semantics.
 *
 * Callers choose the policy: acceptance that starts a host session refuses what
 * does not resolve, while task suggestion creation keeps the recorded path so
 * "start in this session" stays available.
 */
export async function resolveTaskSuggestionHostCwd(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  agentId: string;
  cwd: string;
}): Promise<{ ok: true; cwd: string } | { ok: false; error: ErrorShape }> {
  const hostWorkspaceDir =
    resolveSessionWorkspaceDir(params) ?? resolveAgentWorkspaceDir(params.cfg, params.agentId);
  let sandbox: SandboxWorkspaceInfo | null;
  try {
    sandbox = await ensureSandboxWorkspaceForSession({
      config: params.cfg,
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      workspaceDir: hostWorkspaceDir,
    });
  } catch {
    // An unresolvable sandbox layout still admits a path the host can resolve
    // on its own; only the recorded-broken case below stays out of reach.
    return isExistingHostDirectory(params.cwd)
      ? { ok: true, cwd: params.cwd }
      : {
          ok: false,
          error: unavailableTaskSuggestionCwdError({ cwd: params.cwd, hostWorkspaceDir }),
        };
  }
  if (!sandbox) {
    // Not a sandboxed session: host cwd semantics are unchanged.
    return { ok: true, cwd: params.cwd };
  }
  const mappedHostCwd = sandbox.containerWorkdir
    ? mapCwdThroughSandboxMounts({
        sandbox,
        containerWorkdir: sandbox.containerWorkdir,
        cwd: params.cwd,
      })
    : undefined;
  const hostCwd = mappedHostCwd ?? params.cwd;
  if (isExistingHostDirectory(hostCwd)) {
    return { ok: true, cwd: hostCwd };
  }
  return {
    ok: false,
    error: unavailableTaskSuggestionCwdError({
      cwd: params.cwd,
      ...(mappedHostCwd ? { mappedHostCwd } : {}),
      hostWorkspaceDir: sandbox.workspaceDir,
      ...(sandbox.containerWorkdir ? { containerWorkdir: sandbox.containerWorkdir } : {}),
    }),
  };
}

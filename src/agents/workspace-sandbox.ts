import fs from "node:fs/promises";
import { resolveUserPath } from "../utils.js";
import { resolveAdmittedRunActiveAssertion } from "./admitted-run-context.js";
import { resolveSessionAgentIds } from "./agent-scope.js";
import type { EmbeddedRunAttemptParams } from "./embedded-agent-runner/run/types.js";
import { resolveSandboxContext } from "./sandbox.js";
import { resolveSandboxRuntimeStatus } from "./sandbox/runtime-status.js";
import { resolveEffectiveToolFsWorkspaceOnly } from "./tool-fs-policy.js";

export type WorkspaceSandboxParams = Pick<
  EmbeddedRunAttemptParams,
  | "abortSignal"
  | "agentId"
  | "config"
  | "cwd"
  | "execOverrides"
  | "permissionMode"
  | "sandboxSessionKey"
  | "sandboxAgentId"
  | "sessionId"
  | "sessionKey"
  | "sessionRoot"
  | "skillsSnapshot"
  | "requireWritableSandbox"
  | "requireWorkspaceOnly"
  | "workspaceDir"
> & {
  admittedRunContext?: EmbeddedRunAttemptParams["admittedRunContext"];
  /** Placement execution policy never supplies Gateway-side filesystem or media roots. */
  placementSandbox?: Awaited<ReturnType<typeof resolveSandboxContext>>;
};

function assertSandboxCwd(requestedCwd: string | undefined, workspaceDir: string) {
  if (requestedCwd && requestedCwd !== workspaceDir) {
    throw new Error(
      "cwd override is not supported for sandboxed embedded agent runs; omit cwd or use the agent workspace as cwd",
    );
  }
}

/** Preserve prepared local projection roots without overriding a remote placement owner. */
export function resolveHarnessWorkspace(
  workspaceDir: string,
  params: Pick<WorkspaceSandboxParams, "cwd" | "sessionRoot">,
  prepared: Awaited<ReturnType<typeof resolveAttemptWorkspaceSandbox>> | undefined,
  sandbox: Awaited<ReturnType<typeof resolveSandboxContext>> | undefined,
) {
  const projected =
    prepared?.sandbox?.workspaceSource === "managed-worktree" && prepared.sandbox === sandbox;
  if (projected) {
    assertSandboxCwd(
      params.cwd ? resolveUserPath(params.cwd) : undefined,
      prepared.resolvedWorkspace,
    );
  }
  return {
    workspaceDir: projected ? prepared.effectiveWorkspace : workspaceDir,
    cwd: projected ? prepared.effectiveCwd : params.cwd,
    sessionRoot: projected ? prepared.sessionPermissionRoot : params.sessionRoot,
  };
}

/** Resolves the shared workspace and sandbox policy used by native and plugin harnesses. */
export async function resolveAttemptWorkspaceSandbox(params: WorkspaceSandboxParams) {
  const assertRunCurrent = params.admittedRunContext
    ? resolveAdmittedRunActiveAssertion(params.admittedRunContext, params.abortSignal)
    : undefined;
  if (params.admittedRunContext && !assertRunCurrent) {
    throw new Error("Sandbox preparation requires an active admitted run");
  }
  const assertCurrent = () => {
    params.abortSignal?.throwIfAborted();
    assertRunCurrent?.();
  };
  assertCurrent();
  const { sessionAgentId } = resolveSessionAgentIds({
    sessionKey: params.sessionKey,
    config: params.config,
    agentId: params.agentId,
  });
  const resolvedWorkspace = resolveUserPath(params.workspaceDir);
  await fs.mkdir(resolvedWorkspace, { recursive: true });
  assertCurrent();
  const sessionKey = params.sessionKey?.trim() || params.sessionId;
  const sandboxSessionKey = params.sandboxSessionKey?.trim() || sessionKey;
  const sandboxRuntimeStatus = params.placementSandbox
    ? undefined
    : resolveSandboxRuntimeStatus({
        cfg: params.config,
        // Independent policy sessions keep their own owner.
        agentId:
          params.sandboxAgentId ?? (sandboxSessionKey === sessionKey ? sessionAgentId : undefined),
        sessionKey: sandboxSessionKey,
      });
  const sandbox = sandboxRuntimeStatus
    ? await resolveSandboxContext({
        config: params.config,
        agentId: sandboxRuntimeStatus.agentId,
        execOverrides: params.execOverrides,
        sessionKey: sandboxSessionKey,
        skillsSnapshot: params.skillsSnapshot,
        workspaceDir: resolvedWorkspace,
        assertCurrent,
        admittedRunContext: params.admittedRunContext,
        preparedRuntimeStatus: sandboxRuntimeStatus,
      })
    : null;
  assertCurrent();
  const projectedWorkspace = sandbox?.enabled && sandbox.workspaceSource === "managed-worktree";
  const effectiveWorkspace =
    sandbox?.enabled && (sandbox.workspaceAccess !== "rw" || projectedWorkspace)
      ? (sandbox.workspaceCwd ?? sandbox.workspaceDir)
      : resolvedWorkspace;
  const executionSandbox = params.placementSandbox ?? sandbox;
  if (
    params.requireWritableSandbox &&
    executionSandbox?.enabled &&
    executionSandbox.workspaceAccess !== "rw"
  ) {
    throw new Error("sandbox workspace is not read-write; collection review skipped");
  }
  const requestedCwd = params.cwd ? resolveUserPath(params.cwd) : undefined;
  // Recorded roots pin worktree/explicit-cwd boundaries; rootless sessions use
  // the agent's canonical workspace as their permission boundary.
  const sessionPermissionRoot = projectedWorkspace
    ? sandbox.workspaceDir
    : (params.sessionRoot ?? (await fs.realpath(resolvedWorkspace)));
  const sessionPermissionPolicy = params.permissionMode
    ? {
        root: sessionPermissionRoot,
        mode: params.permissionMode,
      }
    : undefined;
  if (sandbox?.enabled) {
    assertSandboxCwd(requestedCwd, resolvedWorkspace);
  }
  assertCurrent();
  if (effectiveWorkspace !== resolvedWorkspace) {
    await fs.mkdir(effectiveWorkspace, { recursive: true });
  }
  assertCurrent();
  return {
    effectiveCwd: sandbox?.enabled ? effectiveWorkspace : (requestedCwd ?? effectiveWorkspace),
    effectiveFsWorkspaceOnly:
      params.requireWorkspaceOnly === true ||
      resolveEffectiveToolFsWorkspaceOnly({
        cfg: params.config,
        agentId: sessionAgentId,
      }),
    effectiveWorkspace,
    resolvedWorkspace,
    sessionPermissionRoot,
    sessionPermissionPolicy,
    sandbox,
    sandboxReport: sandboxRuntimeStatus
      ? { mode: sandboxRuntimeStatus.mode, sandboxed: sandboxRuntimeStatus.sandboxed }
      : undefined,
    sandboxSessionKey,
    sessionAgentId,
  };
}

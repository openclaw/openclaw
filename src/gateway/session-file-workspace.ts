import { isDeepStrictEqual } from "node:util";
import { ErrorCodes, errorShape } from "../../packages/gateway-protocol/src/index.js";
import { resolveSandboxConfigForAgent } from "../agents/sandbox/config.js";
import { resolveSandboxRuntimeStatus } from "../agents/sandbox/runtime-status.js";
import { resolveSandboxSession } from "../agents/sandbox/session-selection.js";
import { resolveSandboxWorkspaceLayoutPaths } from "../agents/sandbox/shared.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { SessionMutationAuthorizationChangedError } from "./session-mutation-authorization-error.js";
import { resolveSessionWorkspaceRoots } from "./session-workspace-roots.js";

/** File readers consume sandbox selection without preparing or provisioning its workspace. */
export async function prepareSessionFileWorkspace(
  cfg: OpenClawConfig,
  agentId: string,
  sessionKey: string,
  entry: Partial<InternalSessionEntry>,
) {
  const policy = (config: OpenClawConfig, current: Partial<InternalSessionEntry>) => ({
    roots: resolveSessionWorkspaceRoots(config, agentId, current),
    runtime: resolveSandboxRuntimeStatus({
      cfg: config,
      agentId,
      sessionKey,
      preparedSessionEntry: current,
    }),
    sandbox: resolveSandboxConfigForAgent(config, agentId),
    librarySelections: current.skillsSnapshot?.librarySelections,
    worktreeId: current.worktree?.id,
  });
  const selection = (value: ReturnType<typeof policy>) => ({
    roots: value.roots,
    agentId: value.runtime.agentId,
    sandboxed: value.runtime.sandboxed,
    sandboxRequired: value.runtime.sandboxRequired,
    isolationSubject: value.runtime.isolationSubject,
    effectiveAccess: value.runtime.workspaceAccess,
    backend: value.sandbox.backend,
    scope: value.sandbox.scope,
    workspaceAccess: value.sandbox.workspaceAccess,
    workspaceRoot: value.sandbox.workspaceRoot,
    librarySelections: value.librarySelections,
    worktreeId: value.worktreeId,
  });
  const selected = policy(cfg, entry);
  const expected = structuredClone(selection(selected));
  let roots = selected.roots;
  // Managed projects retain their established checkpoint/publication owner.
  // Explicit ro/rw already admits the selected agent workspace to the sandbox.
  if (
    roots.root &&
    !entry.worktree?.id &&
    !entry.repositoryWorkspaceId &&
    !entry.execNode &&
    selected.runtime.sandboxed &&
    (selected.runtime.sandboxRequired
      ? selected.runtime.workspaceAccess
      : selected.sandbox.workspaceAccess) === "none"
  ) {
    const local = selected.sandbox.backend === "docker" || selected.sandbox.backend === "podman";
    const sandbox = local
      ? await resolveSandboxSession({
          config: cfg,
          agentId,
          sessionKey,
          skillsSnapshot: entry.skillsSnapshot,
          preparedRuntimeStatus: selected.runtime,
        })
      : null;
    const root = sandbox
      ? resolveSandboxWorkspaceLayoutPaths({
          cfg: sandbox.cfg,
          rawSessionKey: sandbox.rawSessionKey,
          agentId: sandbox.runtime.agentId,
          isolationSubject: sandbox.runtime.isolationSubject,
          workspaceDir: roots.diffCwd,
        }).workspaceDir
      : undefined;
    // Private files are admitted, but their Git metadata is not a host checkout grant.
    roots = { ...roots, root, spawnedCwd: undefined, diffCwd: undefined, readScope: "root" };
  }
  return {
    ...roots,
    unscopedHostRoot: Boolean(
      roots.root &&
      !entry.repositoryWorkspaceId &&
      !entry.execNode &&
      (!selected.runtime.sandboxed || Boolean(entry.worktree?.id)),
    ),
    assertCurrent(config: OpenClawConfig, current: Partial<InternalSessionEntry>) {
      if (!isDeepStrictEqual(expected, selection(policy(config, current)))) {
        throw new SessionMutationAuthorizationChangedError(
          errorShape(ErrorCodes.FORBIDDEN, "Session workspace changed during file access"),
        );
      }
    },
  };
}

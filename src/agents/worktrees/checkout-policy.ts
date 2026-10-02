import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withWorktreeGitConfig, type WorktreeGitPolicy } from "./checkout-git-config.js";
import type { ManagedWorktreeRecord } from "./types.js";

/** Existing session custody also covers archive/restore before any execution projection exists. */
export async function usesSourceOnlyWorktreeGit(
  record: ManagedWorktreeRecord,
  env: NodeJS.ProcessEnv,
  getConfig: () => OpenClawConfig,
): Promise<boolean> {
  if (record.ownerKind !== "session") {
    return false;
  }
  if (!record.ownerId) {
    return true;
  }
  const [
    { loadSessionEntryReadOnly },
    { resolveSessionStorePathCore },
    { resolveSessionAgentId },
    { resolveSandboxRuntimeStatusesForPersistedSessions },
    { localWorkspaceStore },
  ] = await Promise.all([
    import("../../config/sessions/session-accessor.js"),
    import("../../config/sessions/paths.js"),
    import("../agent-scope.js"),
    import("../sandbox/runtime-status.js"),
    import("../../gateway/worker-environments/local-workspace-store.js"),
  ]);
  if (localWorkspaceStore(env).get(record.id)) {
    return true;
  }
  const cfg = getConfig();
  const agentId = resolveSessionAgentId({ config: cfg, sessionKey: record.ownerId });
  const entry = loadSessionEntryReadOnly({
    agentId,
    sessionKey: record.ownerId,
    env,
    storePath: resolveSessionStorePathCore(cfg.session?.store, { agentId, env }),
    clone: false,
  });
  // Missing or replaced session custody cannot authorize host-side repository programs.
  if (!entry || entry.worktree?.id !== record.id || entry.sandbox === "required") {
    return true;
  }
  return (
    resolveSandboxRuntimeStatusesForPersistedSessions([
      { cfg, agentId, sessionKeys: [record.ownerId], env },
    ])[0]?.[0]?.sandboxed === true
  );
}

export async function withManagedWorktreeGit<T>(
  params: {
    record: ManagedWorktreeRecord;
    env: NodeJS.ProcessEnv;
    getConfig: () => OpenClawConfig;
    signal?: AbortSignal;
    beforeRun?: () => void;
  },
  operation: (git: WorktreeGitPolicy) => Promise<T>,
): Promise<T> {
  const sourceOnly = await usesSourceOnlyWorktreeGit(params.record, params.env, params.getConfig);
  params.beforeRun?.();
  return await withWorktreeGitConfig(params.record.path, sourceOnly, params, operation);
}

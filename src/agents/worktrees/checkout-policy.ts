import { captureIncognitoSessionSource } from "../../config/sessions/session-incognito-binding.js";
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
  const source = captureIncognitoSessionSource({ sessionKey: record.ownerId, env });
  const [
    { readSessionEntryReadOnlyInWorker },
    { resolveSessionStorePathCore },
    { resolveSessionAgentId },
    { resolveSandboxRuntimeStatus },
    { hasLocalWorkspaceProjection },
  ] = await Promise.all([
    import("../../config/sessions/session-entry-read-runtime.js"),
    import("../../config/sessions/paths.js"),
    import("../agent-scope.js"),
    import("../sandbox/runtime-status.js"),
    import("../../gateway/worker-environments/local-workspace-store.js"),
  ]);
  if (await hasLocalWorkspaceProjection(record.id, env)) {
    return true;
  }
  const cfg = getConfig();
  const agentId = resolveSessionAgentId({ config: cfg, sessionKey: record.ownerId });
  source?.admissionSignal?.throwIfAborted();
  if (source) {
    if ("kind" in source) {
      source.assertCurrent();
    } else {
      source.actor.assertReadable();
    }
  }
  const entry = await readSessionEntryReadOnlyInWorker({
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
  return resolveSandboxRuntimeStatus({
    cfg,
    agentId,
    sessionKey: record.ownerId,
    preparedSessionEntry: entry,
  }).sandboxed;
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

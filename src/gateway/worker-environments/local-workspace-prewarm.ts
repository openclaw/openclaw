import fs from "node:fs/promises";
import path from "node:path";
import { listAgentIds, resolveAgentWorkspaceDir } from "../../agents/agent-scope-config.js";
import { resolveSandboxConfigForAgent } from "../../agents/sandbox/config.js";
import { resolveStateDir } from "../../config/state-dir.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";

const log = createSubsystemLogger("agents/worktrees");

export async function prewarmLocalWorkspaceTemplates(params: {
  getConfig: () => OpenClawConfig;
  signal: AbortSignal;
}): Promise<void> {
  const config = params.getConfig();
  if (config.worktreeAcceleration === false) {
    return;
  }
  const { signal } = params;
  const commitGuard = () => {
    signal.throwIfAborted();
    if (params.getConfig() !== config) {
      throw new Error("Sandbox dependency prewarm configuration was replaced");
    }
  };
  const env = process.env;
  for (const agentId of listAgentIds(config)) {
    const sandbox = resolveSandboxConfigForAgent(config, agentId);
    if (sandbox.mode === "off" || (sandbox.backend !== "docker" && sandbox.backend !== "podman")) {
      continue;
    }
    try {
      commitGuard();
      const [
        { withWorktreeMutationLease },
        { resolveWorktreeBase },
        { resolveRepository },
        { withWorktreeRunEnd },
        { withWorktreeSources },
        { prepareLocalWorkspaceTemplate },
      ] = await Promise.all([
        import("../../agents/worktrees/allocation.js"),
        import("../../agents/worktrees/base-ref.js"),
        import("../../agents/worktrees/repository-paths.js"),
        import("../../agents/worktrees/run-end-lifecycle.js"),
        import("../../agents/worktrees/service-preparation.js"),
        import("./local-workspace-template.js"),
      ]);
      commitGuard();
      const repository = await resolveRepository(resolveAgentWorkspaceDir(config, agentId));
      await withWorktreeRunEnd(env, () =>
        withWorktreeMutationLease(
          { env, signal, commitGuard, id: `template-prewarm:${agentId}` },
          (guard) =>
            withWorktreeSources(env, async (retainRepository) => {
              await retainRepository({ ...guard, repository });
              const base = await resolveWorktreeBase(
                repository.repoRoot,
                undefined,
                signal,
                guard.commitGuard,
              );
              const templateRoot = path.join(
                await fs.realpath(resolveStateDir(env)),
                "worktree-projections",
              );
              guard.commitGuard();
              await fs.mkdir(templateRoot, { recursive: true, mode: 0o700 });
              const prepared = await prepareLocalWorkspaceTemplate({
                source: repository.repoRoot,
                repoRoot: repository.repoRoot,
                baseCommit: base.commit,
                temporaryRoot: templateRoot,
                templateRoot,
                env,
                sandbox,
                guard: { ...guard, signal: guard.signal ?? signal },
              });
              await prepared?.record.release();
            }),
        ),
      );
    } catch {
      if (signal.aborted || params.getConfig() !== config) {
        return;
      }
      log.debug(`sandbox dependency template prewarm unavailable for agent ${agentId}`);
    }
  }
}

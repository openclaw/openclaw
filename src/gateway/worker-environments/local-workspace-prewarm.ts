import fs from "node:fs/promises";
import { setImmediate } from "node:timers/promises";
import { listAgentIds } from "../../agents/agent-scope-config.js";
import { resolveSandboxConfigForAgent } from "../../agents/sandbox/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { localWorkspaceProjectionRoot } from "./local-workspace-paths.js";

const log = createSubsystemLogger("agents/worktrees");

export async function prewarmLocalWorkspaceTemplates(params: {
  getConfig: () => OpenClawConfig;
  signal: AbortSignal;
  shouldDefer?: () => Promise<boolean>;
}): Promise<void> {
  const config = params.getConfig();
  if (config.worktreeAcceleration === false) {
    return;
  }
  const { prewarmRecentManagedTemplates } =
    await import("../../agents/worktrees/template-prewarm.js");
  const managedBases = await prewarmRecentManagedTemplates(params);
  const { signal } = params;
  const commitGuard = () => {
    signal.throwIfAborted();
    if (params.getConfig() !== config) {
      throw new Error("Sandbox dependency prewarm configuration was replaced");
    }
  };
  const env = process.env;
  const { recentWorktreeTemplates } = await import("../../agents/worktrees/run-end-lifecycle.js");
  const recipes = [...recentWorktreeTemplates(env).values()].filter(
    (recipe) => recipe.request.sourceOnly,
  );
  if (!recipes.length) {
    return;
  }
  // Keep discovery and sandbox preparation on separate event-loop turns.
  await setImmediate();
  if (await params.shouldDefer?.()) {
    return;
  }
  const templateRoot = await localWorkspaceProjectionRoot(env);
  const visited = new Set<string>();
  for (const agentId of listAgentIds(config)) {
    const sandbox = resolveSandboxConfigForAgent(config, agentId);
    if (sandbox.backend !== "docker" && sandbox.backend !== "podman") {
      continue;
    }
    try {
      commitGuard();
      const [
        { withWorktreeMutationLease },
        { observeWorktreeBase },
        { resolveRepository },
        { withWorktreeRunEnd },
        { withWorktreeSources },
        { prepareLocalWorkspaceTemplate },
        { resolveSandboxDependencyTemplateIdentity },
      ] = await Promise.all([
        import("../../agents/worktrees/allocation.js"),
        import("../../agents/worktrees/base-ref.js"),
        import("../../agents/worktrees/repository-paths.js"),
        import("../../agents/worktrees/run-end-lifecycle.js"),
        import("../../agents/worktrees/service-preparation.js"),
        import("./local-workspace-template.js"),
        import("../../agents/sandbox/dependency-template.js"),
      ]);
      commitGuard();
      const identity = await resolveSandboxDependencyTemplateIdentity(sandbox, {
        signal,
        assertCurrent: commitGuard,
      });
      if (!identity) {
        continue;
      }
      // Successful creates own eligibility for both templates; background rows never extend it.
      for (const candidate of recipes.toReversed()) {
        if (await params.shouldDefer?.()) {
          return;
        }
        const repoRoot = candidate.request.template.repoRoot;
        const baseCommit = managedBases.get(repoRoot);
        if (!baseCommit) {
          continue;
        }
        const key = JSON.stringify([repoRoot, templateRoot, identity.key]);
        if (visited.has(key)) {
          continue;
        }
        visited.add(key);
        try {
          const repository = await resolveRepository(repoRoot);
          await withWorktreeRunEnd(env, () =>
            withWorktreeMutationLease(
              { env, signal, commitGuard, id: `template-prewarm:${agentId}`, idleIoPriority: true },
              (guard) =>
                withWorktreeSources(env, async (retainRepository) => {
                  await retainRepository({ ...guard, repository });
                  const superseded = new AbortController();
                  using _ = observeWorktreeBase((observedRoot, commit) => {
                    if (observedRoot === repository.repoRoot && commit !== baseCommit) {
                      superseded.abort(new Error("Sandbox dependency prewarm base was superseded"));
                    }
                  });
                  guard.commitGuard();
                  await fs.mkdir(templateRoot, { recursive: true, mode: 0o700 });
                  const prepared = await prepareLocalWorkspaceTemplate({
                    source: repository.repoRoot,
                    repoRoot: repository.repoRoot,
                    baseCommit,
                    temporaryRoot: templateRoot,
                    templateRoot,
                    env,
                    sandbox,
                    identity,
                    backgroundUsedAt: candidate.usedAt,
                    // Prepare the default projection manifest along with its dependencies.
                    buildCacheInputs: [],
                    guard: {
                      ...guard,
                      signal: AbortSignal.any([guard.signal ?? signal, superseded.signal]),
                    },
                  });
                  await prepared?.record.release();
                }),
            ),
          );
        } catch {
          commitGuard();
          log.debug(`sandbox dependency template prewarm unavailable for repository ${repoRoot}`);
        }
      }
    } catch {
      if (signal.aborted || params.getConfig() !== config) {
        return;
      }
      log.debug(`sandbox dependency template prewarm unavailable for agent ${agentId}`);
    }
  }
}

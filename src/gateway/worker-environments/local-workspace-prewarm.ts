import fs from "node:fs/promises";
import { listAgentIds } from "../../agents/agent-scope-config.js";
import { resolveSandboxConfigForAgent } from "../../agents/sandbox/config.js";
import { IDLE_GC_MS } from "../../agents/worktrees/retention.js";
import { worktreeTemplateMutationKey } from "../../agents/worktrees/template-registry.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";

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
  const { signal } = params;
  const commitGuard = () => {
    signal.throwIfAborted();
    if (params.getConfig() !== config) {
      throw new Error("Sandbox dependency prewarm configuration was replaced");
    }
  };
  const env = process.env;
  const { listTemplatesAsync } = await import("../../agents/worktrees/template-registry-async.js");
  const usedSince = Date.now() - IDLE_GC_MS;
  const templates = (await listTemplatesAsync(env, commitGuard)).filter(
    (record) => record.backend.startsWith("sandbox-") && record.lastUsedAt > usedSince,
  );
  if (!templates.length) {
    return;
  }
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
        { resolveWorktreeBase, observeWorktreeBase },
        { resolveRepository },
        { withWorktreeRunEnd },
        { withWorktreeSources },
        { prepareLocalWorkspaceTemplate, sandboxTemplateCacheKey },
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
      // The newest foreground use wins across retained generations; background work never renews it.
      const candidates = templates
        .filter(
          (record) =>
            worktreeTemplateMutationKey(record.cacheKey) ===
            sandboxTemplateCacheKey(record.commonDir, record.worktreeRoot, identity.key),
        )
        .toReversed();
      for (const candidate of candidates) {
        if (await params.shouldDefer?.()) {
          return;
        }
        const key = JSON.stringify([candidate.repoRoot, candidate.worktreeRoot, identity.key]);
        if (visited.has(key)) {
          continue;
        }
        visited.add(key);
        try {
          const repository = await resolveRepository(candidate.repoRoot);
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
                  const templateRoot = candidate.worktreeRoot;
                  const superseded = new AbortController();
                  using _ = observeWorktreeBase((repoRoot, commit) => {
                    if (repoRoot === repository.repoRoot && commit !== base.commit) {
                      superseded.abort(new Error("Sandbox dependency prewarm base was superseded"));
                    }
                  });
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
                    identity,
                    backgroundUsedAt: candidate.lastUsedAt,
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
          log.debug(
            `sandbox dependency template prewarm unavailable for repository ${candidate.repoRoot}`,
          );
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

import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { withWorktreePreparationTiming } from "./preparation-timing.js";
import { recentWorktreeTemplates } from "./run-end-lifecycle.js";

const log = createSubsystemLogger("agents/worktrees");

/** The idle pass owns discovery; successful creates alone retain and renew recipes. */
export async function prewarmRecentManagedTemplates(params: {
  getConfig: () => OpenClawConfig;
  signal: AbortSignal;
  shouldDefer?: () => Promise<boolean>;
}): Promise<Map<string, string>> {
  const config = params.getConfig();
  const observed = new Map<string, string>();
  if (config.worktreeAcceleration === false) {
    return observed;
  }
  const recipes = recentWorktreeTemplates(process.env);
  if (!recipes.size) {
    return observed;
  }
  const [{ observeWorktreeBase, resolveWorktreeBase }, { managedWorktrees }] = await Promise.all([
    import("./base-ref.js"),
    import("./service.js"),
  ]);
  const commitGuard = () => {
    params.signal.throwIfAborted();
    if (params.getConfig() !== config) {
      throw new Error("Managed template prewarm configuration changed");
    }
  };
  const observe = (repoRoot: string, commit: string) => {
    for (const recipe of recipes.values()) {
      if (recipe.request.template.repoRoot === repoRoot) {
        recipe.targetCommit = commit;
      }
    }
  };
  using _ = observeWorktreeBase(observe);
  for (const recipe of recipes.values()) {
    commitGuard();
    if (await params.shouldDefer?.()) {
      break;
    }
    const repoRoot = recipe.request.template.repoRoot;
    observed.set(repoRoot, recipe.targetCommit);
    try {
      if (Date.now() >= recipe.nextFetchAt) {
        // Different policies of one repository share both discovery and its cooldown.
        const nextFetchAt = Date.now() + 120_000;
        for (const other of recipes.values()) {
          if (other.request.template.repoRoot === repoRoot) {
            other.nextFetchAt = nextFetchAt;
          }
        }
        const base = await resolveWorktreeBase(
          repoRoot,
          undefined,
          params.signal,
          commitGuard,
          "preserve",
          true,
        );
        observe(repoRoot, base.commit);
      }
      observed.set(repoRoot, recipe.targetCommit);
      while (recipe.targetCommit !== recipe.preparedCommit) {
        if (await params.shouldDefer?.()) {
          return observed;
        }
        const targetCommit = recipe.targetCommit;
        const started = performance.now();
        await withWorktreePreparationTiming("managed-prewarm", () =>
          managedWorktrees.prewarm(
            { ...recipe.request, targetCommit, backgroundUsedAt: recipe.usedAt },
            { signal: params.signal, commitGuard, idleIoPriority: true },
          ),
        );
        recipe.preparedCommit = targetCommit;
        log.info(
          `managed template background refresh targetCommit=${targetCommit} durationMs=${Math.round(performance.now() - started)}`,
        );
      }
      observed.set(repoRoot, recipe.targetCommit);
    } catch (error) {
      commitGuard();
      log.debug(`managed template background refresh unavailable: ${String(error)}`);
    }
  }
  return observed;
}

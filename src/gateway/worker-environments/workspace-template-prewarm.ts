import { withWorktreeMutationLease } from "../../agents/worktrees/allocation.js";
import {
  estimateWorktreeGitBytes,
  requireAllocationSpace,
} from "../../agents/worktrees/capacity.js";
import { prepareManagedWorktreeTemplate } from "../../agents/worktrees/checkout.js";
import { resolveRepository } from "../../agents/worktrees/repository-paths.js";
import { withWorktreeRunEnd } from "../../agents/worktrees/run-end-lifecycle.js";
import { withWorktreeSources } from "../../agents/worktrees/service-preparation.js";
import { collectWorktreeTemplates } from "../../agents/worktrees/template-cache.js";
import type { WorktreeTemplateRecipe } from "../../agents/worktrees/template-prewarm.types.js";
import type { WorktreeTemplateRecord } from "../../agents/worktrees/template-registry.js";
import { prepareLocalWorkspaceTemplate } from "./local-workspace-template.js";

/** Reacquire maintenance custody instead of borrowing the request that observed this template. */
export async function prewarmWorkspaceTemplate(
  recipe: WorktreeTemplateRecipe,
  commit: string,
  params: { signal: AbortSignal; commitGuard: () => void },
): Promise<void> {
  const env = process.env;
  const { template } = recipe;
  await withWorktreeRunEnd(env, () =>
    withWorktreeMutationLease(
      { ...params, env, id: `prewarm:${template.cacheKey}:${commit}` },
      (guard) =>
        withWorktreeSources(env, async (retainRepository) => {
          const repository = await resolveRepository(template.repoRoot);
          if (repository.commonDir !== template.commonDir) {
            return;
          }
          await retainRepository({ ...guard, repository });
          let preparedRecord: WorktreeTemplateRecord | undefined;
          if (template.sourceCommit === commit) {
            // Foreground preparation can finish first; its obsolete generations still need collection.
            preparedRecord = template;
          } else if (recipe.kind === "managed") {
            const bytes = await estimateWorktreeGitBytes(repository.repoRoot, commit, {
              signal: guard.signal,
              assertCurrent: guard.commitGuard,
              preparationKey: commit,
            });
            const prepared = await prepareManagedWorktreeTemplate({
              ...guard,
              env,
              now: Date.now,
              enabled: true,
              background: true,
              useWarmPool: false,
              repoRoot: repository.repoRoot,
              commonDir: repository.commonDir,
              worktreeRoot: template.worktreeRoot,
              // Read checkout policy here; the template owner validates and retains
              // its source. A retired policy path simply makes prewarming unavailable.
              destination: template.path,
              sourceOnly: recipe.sourceOnly,
              base: commit,
              requireSpace: (cloneBytes) =>
                requireAllocationSpace(
                  guard,
                  env,
                  template.worktreeRoot,
                  repository,
                  cloneBytes ?? 2 * bytes,
                ),
            });
            await prepared?.record.release();
            preparedRecord = prepared?.record;
          } else {
            const prepared = await prepareLocalWorkspaceTemplate({
              source: repository.repoRoot,
              repoRoot: repository.repoRoot,
              baseCommit: commit,
              temporaryRoot: template.worktreeRoot,
              templateRoot: template.worktreeRoot,
              env,
              sandbox: recipe.sandbox,
              buildCacheInputs: recipe.buildCacheInputs,
              background: true,
              guard: { ...guard, signal: guard.signal ?? params.signal },
            });
            await prepared?.record.release();
            preparedRecord = prepared?.record;
          }
          if (preparedRecord) {
            await collectWorktreeTemplates(env, 0, {
              ...guard,
              scope: { commonDir: template.commonDir, worktreeRoot: template.worktreeRoot },
              supersededBy: preparedRecord,
            });
          }
        }),
    ),
  );
}

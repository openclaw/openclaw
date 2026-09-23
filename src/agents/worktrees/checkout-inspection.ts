import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { runGitWorkerOperation } from "../../infra/git-worker.js";
import { withManagedWorktreeGit } from "./checkout-policy.js";
import { getRegistryWorktreeProvisionedPaths } from "./registry.js";
import type { ManagedWorktreeRecord } from "./types.js";

export async function inspectManagedWorktreeCheckout(
  record: ManagedWorktreeRecord,
  kind: "lossless" | "provisioned" | "nested-repository",
  context: { env: NodeJS.ProcessEnv; getConfig: () => OpenClawConfig },
) {
  return await withManagedWorktreeGit({ record, ...context }, async (git) =>
    runGitWorkerOperation(
      {
        type: "worktree.cleanup-inspection",
        input:
          kind === "nested-repository"
            ? { kind, checkoutPath: record.path }
            : {
                kind,
                checkoutPath: record.path,
                provisionedPaths: await getRegistryWorktreeProvisionedPaths(context.env, record.id),
              },
      },
      { git: git.worker },
    ),
  );
}

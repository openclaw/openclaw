import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { runGitWorkerOperation } from "../../infra/git-worker.js";
import { withManagedWorktreeGit } from "./checkout-policy.js";
import { worktreePathExists } from "./git.js";
import { getRegistryWorktreeProvisionedPaths } from "./registry.js";
import { resolveRepository } from "./service-preparation.js";
import type { ManagedWorktreeRecord } from "./types.js";

/** A broken link is orphaned only when its original repository is still available. */
export async function hasMissingManagedWorktreeGitdir(record: ManagedWorktreeRecord) {
  const link = await fs.readFile(path.join(record.path, ".git"), "utf8");
  const target = /^gitdir: (.+)\r?\n?$/u.exec(link)?.[1]?.trim();
  if (!target) {
    return false;
  }
  const gitdir = path.resolve(record.path, target);
  if (await worktreePathExists(gitdir)) {
    return false;
  }
  const repository = await resolveRepository(record.repoRoot);
  return (
    repository.fingerprint === record.repoFingerprint &&
    path.dirname(gitdir) === path.join(repository.commonDir, "worktrees")
  );
}

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

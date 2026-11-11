import fs from "node:fs/promises";
import path from "node:path";
import { root as fsRoot } from "../../infra/fs-safe.js";
import { requireGitCommandOutput, type GitCommandOptions } from "../../infra/git-exec.js";
import { withWorktreeGitConfig, type WorktreeGitPolicy } from "./checkout-git-config.js";
import type {
  WorktreeFilesystemBackend,
  WorktreeFilesystemOptions,
} from "./filesystem-backend.types.js";
import { resolveGitMetadataPath, WORKTREE_CHECKOUT_TIMEOUT_MS, type GitResult } from "./git.js";
import { timeWorktreePreparationPhase } from "./preparation-timing.js";
import type { WorktreeTemplateRecord } from "./template-registry.js";

export async function estimateTemplateCloneBytes(template: {
  sourceIndex: string;
  backend: Pick<WorktreeFilesystemBackend, "estimateCloneBytes">;
}): Promise<number | undefined> {
  const index = await fs.open(template.sourceIndex, "r");
  try {
    const header = Buffer.alloc(12);
    const { bytesRead } = await index.read(header, 0, header.length, 0);
    const { size } = await index.stat();
    const version = header.readUInt32BE(4);
    const entries = header.readUInt32BE(8);
    // Git already validated the template. Unsupported or incomplete index headers
    // cannot justify reduced admission; retain the full checkout allowance.
    if (
      bytesRead !== 12 ||
      header.toString("ascii", 0, 4) !== "DIRC" ||
      version < 2 ||
      version > 4 ||
      entries > Math.floor((size - 12) / 62)
    ) {
      return undefined;
    }
    return template.backend.estimateCloneBytes(entries, size);
  } finally {
    await index.close();
  }
}

/** Advance a private clone without changing the published source's files or Git metadata. */
export async function cloneManagedWorktreeTemplate(
  params: {
    source: Pick<WorktreeTemplateRecord, "path" | "sourceCommit">;
    target: Pick<WorktreeTemplateRecord, "path" | "sourceCommit">;
    backend: WorktreeFilesystemBackend;
    git: WorktreeGitPolicy;
    checkoutBudget?: Pick<GitCommandOptions, "timeoutMs" | "killGraceMs">;
  },
  options: WorktreeFilesystemOptions,
  checkoutOptions: GitCommandOptions,
): Promise<void> {
  const assertCurrent = () => {
    options.signal?.throwIfAborted();
    options.commitGuard();
  };
  const gitOptions = { signal: options.signal, beforeRun: assertCurrent, killProcessTree: true };
  const markerPath = path.join(params.target.path, ".git");
  const marker = await fs.readFile(markerPath);
  const destinationIndex = await resolveGitMetadataPath(params.target.path, "index", gitOptions);
  const sourceIndex = await resolveGitMetadataPath(params.source.path, "index", gitOptions);
  assertCurrent();
  await fs.unlink(markerPath);
  assertCurrent();
  await fs.rmdir(params.target.path);
  await params.backend.cloneTemplate(params.source.path, params.target.path, options);
  const cloneCompletedAtMs = Date.now();
  // Replace the copied source link before any staged index or HEAD mutation.
  assertCurrent();
  await fs.unlink(markerPath);
  assertCurrent();
  await fs.writeFile(markerPath, marker);
  await prepareClonedWorktreeIndex(
    {
      source: params.source.path,
      sourceIndex,
      destination: params.target.path,
      destinationIndex,
      apfsCloneCompletedAtMs: params.backend.id === "apfs" ? cloneCompletedAtMs : undefined,
      sourceOnly: params.git.sourceOnly,
      checkoutBudget: params.checkoutBudget,
    },
    options,
  );
  const materialized = await materializeManagedWorktree(
    {
      destination: params.target.path,
      commit: params.target.sourceCommit,
      preparedGit: params.git,
      executionTimeoutMs: params.checkoutBudget?.timeoutMs,
    },
    checkoutOptions,
  );
  requireGitCommandOutput("git read-tree", materialized);
  await params.git.require(
    params.target.path,
    ["update-ref", "--no-deref", "HEAD", params.target.sourceCommit, params.source.sourceCommit],
    gitOptions,
  );
}

/** Materialization and restore share one filter-safe operation boundary. */
export async function materializeManagedWorktree(
  params: {
    destination: string;
    commit: string;
    sourceOnly?: boolean;
    resetIndexTo?: string;
    removeExisting?: boolean;
    preparedGit?: WorktreeGitPolicy;
    /** Native PR provisioning retains its caller-owned absolute deadline. */
    executionTimeoutMs?: number;
  },
  options: GitCommandOptions,
  indexOptions: GitCommandOptions = options,
): Promise<GitResult> {
  const materialize = async (git: WorktreeGitPolicy) => {
    if (params.removeExisting) {
      await git.require(
        params.destination,
        ["rm", "-r", "--force", "--ignore-unmatch", "--", "."],
        options,
      );
    }
    const result = await git.run(
      params.destination,
      ["read-tree", "--verbose", "--reset", "--no-recurse-submodules", "-u", params.commit],
      {
        ...options,
        env: { ...options.env, GIT_NO_LAZY_FETCH: "1" },
        // Git emits progress as files complete. Storage contention must not
        // kill a progressing checkout merely because five minutes elapsed.
        waitForExit: params.executionTimeoutMs === undefined,
        timeoutMs: params.executionTimeoutMs ?? options.timeoutMs,
        noOutputTimeoutMs:
          params.executionTimeoutMs === undefined ? WORKTREE_CHECKOUT_TIMEOUT_MS : undefined,
      },
    );
    if (result.code === 0 && params.resetIndexTo) {
      await git.require(
        params.destination,
        params.sourceOnly ? ["read-tree", "--reset", params.resetIndexTo] : ["reset"],
        indexOptions,
      );
    }
    return result;
  };
  return params.preparedGit
    ? await materialize(params.preparedGit)
    : await withWorktreeGitConfig(
        params.destination,
        params.sourceOnly === true,
        indexOptions,
        materialize,
      );
}

/** Install the cloned index, preserving APFS stat rebasing and the shared refresh boundary. */
export async function prepareClonedWorktreeIndex(
  params: {
    source: string;
    sourceIndex: string;
    destination: string;
    destinationIndex: string;
    apfsCloneCompletedAtMs?: number;
    sourceOnly?: boolean;
    checkoutBudget?: Pick<GitCommandOptions, "timeoutMs" | "killGraceMs">;
  },
  options: WorktreeFilesystemOptions,
): Promise<void> {
  const assertCurrent = () => {
    options.signal?.throwIfAborted();
    options.commitGuard();
  };
  await timeWorktreePreparationPhase("indexCopy", async () => {
    if (params.apfsCloneCompletedAtMs !== undefined) {
      const { copyApfsCloneIndex } = await import("./checkout-apfs.js");
      if (
        await copyApfsCloneIndex(
          params.source,
          params.destination,
          params.sourceIndex,
          params.destinationIndex,
          { ...options, cloneCompletedAtMs: params.apfsCloneCompletedAtMs },
        )
      ) {
        return;
      }
    }
    assertCurrent();
    const sourceIndex = await fs.realpath(params.sourceIndex);
    const [sourceRoot, destinationRoot] = await Promise.all([
      fsRoot(path.dirname(sourceIndex)),
      fsRoot(path.dirname(params.destinationIndex)),
    ]);
    await destinationRoot.copyIn(
      path.basename(params.destinationIndex),
      { root: sourceRoot, relativePath: `./${path.basename(sourceIndex)}` },
      {
        clone: "auto",
        durable: false,
        mkdir: false,
        overwrite: true,
        preserveSourceMode: true,
        sourceHardlinks: "allow",
        signal: options.signal,
        assertBeforeMutation: assertCurrent,
      },
    );
  });
  const gitOptions = { signal: options.signal, beforeRun: assertCurrent, killProcessTree: true };
  await timeWorktreePreparationPhase("indexRefresh", () =>
    withWorktreeGitConfig(params.destination, params.sourceOnly === true, gitOptions, (git) =>
      git.require(params.destination, ["update-index", "--refresh"], {
        ...gitOptions,
        timeoutMs: WORKTREE_CHECKOUT_TIMEOUT_MS,
        ...params.checkoutBudget,
      }),
    ),
  );
}

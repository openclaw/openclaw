import path from "node:path";
import type { ManagedWorktreeBranchesResult } from "../agents/worktrees/types.js";
import { runWithGatewayDetachedWorkContinuation } from "../process/gateway-work-admission.js";
import { monotonicNow } from "../shared/monotonic-time.js";
import type { GitReadOperations, GitReadOptions } from "./git-read-operations.js";
import { runGitWorkerOperation } from "./git-worker.js";
import { observeOwnedDirectory } from "./owned-directory-observation.js";

type Entry = {
  value?: ManagedWorktreeBranchesResult;
  pending?: Promise<ManagedWorktreeBranchesResult>;
  controller?: AbortController;
  dirty: boolean;
  retryAt: number;
  observation?: string;
  watches: ReturnType<typeof observeOwnedDirectory>[];
};

/** Picker facts survive reader-worker retirement; only ref/config events invalidate them. */
export function createBranchReadCache(environment: () => unknown) {
  const entries = new Map<string, Entry>();
  return {
    async read(
      input: GitReadOperations["repository.branches"]["input"],
      options: GitReadOptions = {},
    ) {
      options.signal?.throwIfAborted();
      if (!options.snapshot) {
        const { observation: _observation, ...result } = await runGitWorkerOperation(
          { type: "repository.branches", input },
          options,
        );
        return result;
      }
      const key = JSON.stringify([input.repoRoot, environment()]);
      let entry = entries.get(key);
      if (!entry) {
        if (entries.size >= 64) {
          const oldest = [...entries].find(([, candidate]) => !candidate.pending);
          if (oldest) {
            oldest[1].watches.forEach((watch) => watch.close());
            entries.delete(oldest[0]);
          } else {
            return { branches: [], branchesUnavailable: true };
          }
        }
        entry = { dirty: true, retryAt: 0, watches: [] };
        entries.set(key, entry);
      }
      const selected = entry;
      if (
        !entry.pending &&
        (options.refresh || entry.dirty || (entry.retryAt > 0 && monotonicNow() >= entry.retryAt))
      ) {
        entry.dirty = false;
        const controller = new AbortController();
        entry.controller = controller;
        entry.pending = runWithGatewayDetachedWorkContinuation(async () => {
          const timeout = setTimeout(() => controller.abort(), 2_000);
          try {
            const { observation, ...value } = await runGitWorkerOperation(
              {
                type: "repository.branches",
                input: { repoRoot: input.repoRoot, includeRepositoryStatus: true },
              },
              { signal: controller.signal },
            );
            const observationKey = JSON.stringify(observation);
            if (!selected.watches.length || selected.observation !== observationKey) {
              selected.watches.forEach((watch) => watch.close());
              selected.watches = [];
              selected.observation = observationKey;
              const invalidate = (_filename?: string, event?: string) => {
                // Reconciliation ticks do not expire recorded refs. A lost native watch does.
                if (event || selected.watches.some((watch) => !watch.isWatching())) {
                  selected.dirty = true;
                }
              };
              const metadata = new Set(
                observation
                  ? [observation.gitDir, observation.commonDir]
                  : [path.join(input.repoRoot, ".git")],
              );
              for (const directory of metadata) {
                selected.watches.push(
                  observeOwnedDirectory(directory, (filename, event) => {
                    if (
                      !filename ||
                      /^(HEAD|packed-refs|config|config.worktree|commondir|refs|reftable)$/.test(
                        filename,
                      )
                    ) {
                      invalidate(filename, event);
                    }
                  }),
                );
              }
              if (observation) {
                selected.watches.push(
                  observeOwnedDirectory(observation.root, (filename, event) => {
                    if (!filename || filename === ".git") {
                      invalidate(filename, event);
                    }
                  }),
                );
                selected.watches.push(
                  observeOwnedDirectory(path.join(observation.commonDir, "refs"), invalidate, {
                    recursive: true,
                  }),
                );
                selected.watches.push(
                  observeOwnedDirectory(path.join(observation.commonDir, "reftable"), invalidate, {
                    recursive: true,
                  }),
                );
              }
            }
            selected.value =
              value.repositoryStatus === "unavailable" || value.branchesUnavailable
                ? { ...(selected.value ?? value), branchesUnavailable: true }
                : value;
            // A later request must discover Git initialized in an unwatched ancestor.
            selected.retryAt =
              value.repositoryStatus === "not_git" ||
              value.repositoryStatus === "unavailable" ||
              value.branchesUnavailable
                ? monotonicNow() + 5_000
                : 0;
          } catch {
            selected.value = {
              ...(selected.value ?? { branches: [], repositoryStatus: "unavailable" }),
              branchesUnavailable: true,
            };
            // A later user request can retry a failed read; there is no background polling.
            selected.retryAt = monotonicNow() + 5_000;
          } finally {
            clearTimeout(timeout);
            selected.pending = undefined;
            selected.controller = undefined;
          }
          return selected.value!;
        }, "runtime:branch-discovery");
      }
      if (entry.pending && options.onRefresh) {
        void entry.pending.then(options.onRefresh).catch(() => {});
      }
      const value = {
        ...(entry.value ?? { branches: [] }),
        ...(entry.pending ? { refreshing: true } : {}),
      };
      if (input.includeRepositoryStatus) {
        return value;
      }
      const { repositoryStatus: _status, ...branches } = value;
      return branches;
    },
    async close() {
      for (const entry of entries.values()) {
        entry.controller?.abort();
      }
      await Promise.allSettled(
        [...entries.values()].flatMap((entry) => (entry.pending ? [entry.pending] : [])),
      );
      for (const entry of entries.values()) {
        entry.watches.forEach((watch) => watch.close());
      }
      entries.clear();
    },
  };
}

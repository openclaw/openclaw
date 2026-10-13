import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { GitReadOperation, GitReadOperations } from "./git-read-operations.js";
import { runGitWorkerOperation } from "./git-worker.js";
import { pruneMapToMaxSize } from "./map-size.js";

const MAX_CACHED_CHECKOUTS = 1_000;

export type GitReadOptions = {
  /** Refresh unversioned layouts; known revisions are always revalidated. */
  refresh?: boolean;
  signal?: AbortSignal;
};

type ReadEntry<T> = {
  revision: string;
  expiresAt: number;
  promise: Promise<T>;
  controller: AbortController;
  subscribers: number;
  pending: boolean;
};

function subscribe<T>(
  entry: ReadEntry<T>,
  clone: (value: T) => T,
  signal?: AbortSignal,
): Promise<T> {
  entry.subscribers += 1;
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (complete: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      signal?.removeEventListener("abort", abort);
      entry.subscribers -= 1;
      if (entry.pending && entry.subscribers === 0) {
        entry.expiresAt = 0;
        entry.controller.abort();
        // Final cancellation remains joined to the owner's process teardown.
        void entry.promise.then(complete, complete);
        return;
      }
      complete();
    };
    const abort = () => finish(() => reject(toErrorObject(signal?.reason, "Git read aborted")));
    signal?.addEventListener("abort", abort, { once: true });
    entry.promise.then(
      (value) => finish(() => resolve(clone(value))),
      (error: unknown) => finish(() => reject(toErrorObject(error, "Git read failed"))),
    );
    if (signal?.aborted) {
      abort();
    }
  });
}

function createReadCache<Input, Output>(
  load: (input: Input, signal: AbortSignal) => Promise<Output>,
  freshnessMs: number,
  clone: (value: Output) => Output = structuredClone,
  revision?: (input: Input, signal: AbortSignal) => Promise<string | null>,
  keyOf: (input: Input) => string = JSON.stringify,
) {
  // Versioned reads retain only the current inputs/revision per checkout. LRU
  // eviction and Gateway shutdown own their lifetime, independently of viewers.
  const entries = new Map<string, ReadEntry<Output>>();
  const pending = new Set<ReadEntry<Output>>();
  const revisions = new Map<AbortController, Promise<string | null>>();
  let closed = false;
  const remove = (key: string, entry: ReadEntry<Output>) => {
    if (entries.get(key) === entry) {
      entries.delete(key);
    }
  };
  return {
    async read(input: Input, options: GitReadOptions = {}): Promise<Output> {
      options.signal?.throwIfAborted();
      const prepared = structuredClone(input);
      const key = keyOf(prepared);
      let currentRevision: string | null | undefined;
      if (revision) {
        const controller = new AbortController();
        const check = revision(
          prepared,
          options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal,
        );
        revisions.set(controller, check);
        try {
          currentRevision = await check;
        } finally {
          revisions.delete(controller);
        }
      }
      const revisionKey = JSON.stringify([prepared, currentRevision]);
      options.signal?.throwIfAborted();
      if (closed) {
        throw new Error("Git reads are unavailable while the Gateway is restarting");
      }
      let entry = entries.get(key);
      if (
        (options.refresh && currentRevision === null) ||
        !entry ||
        entry.revision !== revisionKey ||
        entry.expiresAt <= Date.now()
      ) {
        const controller = new AbortController();
        const next: ReadEntry<Output> = {
          revision: revisionKey,
          expiresAt:
            freshnessMs === 0
              ? Number.POSITIVE_INFINITY
              : Date.now() +
                (currentRevision === null ? Math.min(freshnessMs, 75_000) : freshnessMs),
          controller,
          subscribers: 0,
          pending: true,
          promise: Promise.resolve().then(() => load(prepared, controller.signal)),
        };
        pending.add(next);
        next.promise = next.promise.then(
          (value) => {
            next.pending = false;
            pending.delete(next);
            controller.signal.throwIfAborted();
            if (freshnessMs === 0) {
              remove(key, next);
            }
            return value;
          },
          (error: unknown) => {
            next.pending = false;
            pending.delete(next);
            next.expiresAt = 0;
            remove(key, next);
            throw error;
          },
        );
        // Replace at admission. An older completion updates only its own entry.
        entry = next;
      }
      entries.delete(key);
      entries.set(key, entry);
      pruneMapToMaxSize(entries, MAX_CACHED_CHECKOUTS);
      return subscribe(entry, clone, options.signal);
    },
    async close(): Promise<void> {
      closed = true;
      for (const controller of revisions.keys()) {
        controller.abort();
      }
      const retiring = [...pending];
      for (const entry of retiring) {
        entry.expiresAt = 0;
        entry.controller.abort();
      }
      entries.clear();
      await Promise.allSettled([...revisions.values(), ...retiring.map((entry) => entry.promise)]);
    },
  };
}

function createReadCaches() {
  return {
    identities: createReadCache(
      (input: GitReadOperations["repository.identities"]["input"], signal) =>
        runGitWorkerOperation({ type: "repository.identities", input }, { signal }),
      // Identity includes Git config and worktree relocation inputs without a complete revision.
      // Share only pending passes so later discovery always sees external changes.
      0,
    ),
    context: createReadCache(
      (input: GitReadOperations["checkout.context"]["input"], signal) =>
        runGitWorkerOperation({ type: "checkout.context", input }, { signal }),
      Number.POSITIVE_INFINITY,
      structuredClone,
      (input, signal) =>
        runGitWorkerOperation(
          { type: "checkout.revision", input: { root: input.root, includeIndex: false } },
          { signal },
        ),
      (input) => input.root,
    ),
    branchFacts: createReadCache(
      (input: GitReadOperations["pull-request.branch-facts"]["input"], signal) =>
        runGitWorkerOperation({ type: "pull-request.branch-facts", input }, { signal }),
      // Unstaged edits do not advance the ref/index revision.
      5 * 60_000,
      structuredClone,
      (input, signal) =>
        runGitWorkerOperation(
          {
            type: "checkout.revision",
            input: { ...input, includeIndex: true },
          },
          { signal },
        ),
      (input) => input.root,
    ),
    diff: createReadCache(
      (input: GitReadOperations["checkout.diff"]["input"], signal) =>
        runGitWorkerOperation({ type: "checkout.diff", input }, { signal }),
      0,
      // Callers mutate transport fields; immutable patch strings can stay shared.
      (diff) => ({
        ...diff,
        files: diff.files.map((file) => ({ ...file })),
        ...(diff.commits ? { commits: diff.commits.map((commit) => ({ ...commit })) } : {}),
        ...(diff.mergeBase ? { mergeBase: { ...diff.mergeBase } } : {}),
      }),
    ),
    branches: createReadCache(
      (input: GitReadOperations["repository.branches"]["input"], signal) =>
        runGitWorkerOperation({ type: "repository.branches", input }, { signal }),
      0,
    ),
    baseline: createReadCache(
      (input: GitReadOperations["checkout.baseline"]["input"], signal) =>
        runGitWorkerOperation({ type: "checkout.baseline", input }, { signal }),
      0,
    ),
  };
}

type GitReadRuntime = { caches?: ReturnType<typeof createReadCaches>; closing?: Promise<void> };

function runtime(): GitReadRuntime {
  return resolveGlobalSingleton<GitReadRuntime>(
    Symbol.for("openclaw.gitReadCache"),
    () => ({}),
    (state) => {
      state.closing ??= Promise.resolve()
        .then(async () => {
          const caches = state.caches;
          state.caches = undefined;
          if (caches) {
            await Promise.all(Object.values(caches).map((cache) => cache.close()));
          }
        })
        .finally(() => {
          state.closing = undefined;
        });
      return state.closing;
    },
  );
}

export function runGitReadOperation<K extends keyof GitReadOperations>(
  operation: { type: K; input: GitReadOperations[K]["input"] },
  options?: GitReadOptions,
): Promise<GitReadOperations[K]["output"]>;
export function runGitReadOperation(operation: GitReadOperation, options?: GitReadOptions) {
  const state = runtime();
  if (state.closing) {
    return Promise.reject(new Error("Git reads are unavailable while the Gateway is restarting"));
  }
  const { context, branchFacts, diff, branches, baseline, identities } = (state.caches ??=
    createReadCaches());
  switch (operation.type) {
    case "repository.identities":
      return identities.read(operation.input, options);
    case "checkout.revision":
      return runGitWorkerOperation(operation, options);
    case "checkout.context":
      return context.read(operation.input, options);
    case "pull-request.branch-facts":
      return branchFacts.read(operation.input, options);
    case "checkout.diff":
      return diff.read(operation.input, options);
    case "repository.branches":
      return branches.read(operation.input, options);
    case "checkout.baseline":
      return baseline.read(operation.input, options);
  }
  throw new Error("Unsupported Git read operation");
}

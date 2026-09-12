import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { GitReadOperation, GitReadOperations } from "./git-read-operations.js";
import { runGitWorkerOperation } from "./git-worker.js";
import { createRetainedCache } from "./retained-cache.js";

export type GitReadOptions = {
  refresh?: boolean;
  signal?: AbortSignal;
  /** Subscription lifetime pins freshness state; it does not cancel an active caller. */
  cacheSignal?: AbortSignal;
};

type ReadEntry<T> = {
  expiresAt: number;
  promise: Promise<T>;
  controller: AbortController;
  subscribers: number;
  pending: boolean;
};

function subscribe<T>(entry: ReadEntry<T>, signal?: AbortSignal): Promise<T> {
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
      (value) => finish(() => resolve(structuredClone(value))),
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
) {
  const entries = createRetainedCache<ReadEntry<Output>>();
  const pending = new Set<ReadEntry<Output>>();
  return {
    async read(input: Input, options: GitReadOptions = {}): Promise<Output> {
      options.signal?.throwIfAborted();
      const prepared = structuredClone(input);
      const key = JSON.stringify(prepared);
      let entry = entries.get(key, options.cacheSignal);
      if (options.refresh || !entry || entry.expiresAt <= Date.now()) {
        const controller = new AbortController();
        const next: ReadEntry<Output> = {
          expiresAt: freshnessMs === 0 ? Number.POSITIVE_INFINITY : Date.now() + freshnessMs,
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
              entries.delete(key, next);
            }
            return value;
          },
          (error: unknown) => {
            next.pending = false;
            pending.delete(next);
            next.expiresAt = 0;
            entries.delete(key, next);
            throw error;
          },
        );
        // Replace at admission. An older completion updates only its own entry.
        entries.set(key, next, options.cacheSignal);
        entry = next;
      }
      return subscribe(entry, options.signal);
    },
    async close(): Promise<void> {
      const retiring = [...pending];
      for (const entry of retiring) {
        entry.expiresAt = 0;
        entry.controller.abort();
      }
      entries.clear();
      await Promise.allSettled(retiring.map((entry) => entry.promise));
    },
    release: entries.release,
  };
}

// Existing sidebar freshness spans its 60-second poll. Mutable checkout facts
// otherwise live only for concurrent readers and retire with the Gateway.
function createReadCaches() {
  return {
    context: createReadCache(
      (input: GitReadOperations["checkout.context"]["input"], signal) =>
        runGitWorkerOperation({ type: "checkout.context", input }, { signal }),
      75_000,
    ),
    branchFacts: createReadCache(
      (input: GitReadOperations["pull-request.branch-facts"]["input"], signal) =>
        runGitWorkerOperation({ type: "pull-request.branch-facts", input }, { signal }),
      75_000,
    ),
    diff: createReadCache(
      (input: GitReadOperations["checkout.diff"]["input"], signal) =>
        runGitWorkerOperation({ type: "checkout.diff", input }, { signal }),
      0,
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

export function releaseGitReadCache(
  type: "checkout.context" | "pull-request.branch-facts",
  signal?: AbortSignal,
): void {
  const caches = runtime().caches;
  if (caches) {
    (type === "checkout.context" ? caches.context : caches.branchFacts).release(signal);
  }
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
  const { context, branchFacts, diff, branches, baseline } = (state.caches ??= createReadCaches());
  switch (operation.type) {
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

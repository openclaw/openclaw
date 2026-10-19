import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { runWithGatewayDetachedWorkContinuation } from "../process/gateway-work-admission.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { racePromiseWithAbortSignal } from "./abort-signal.js";
import type { GitReadOperation, GitReadOperations } from "./git-read-operations.js";
import type { GitWorkerOperations } from "./git-worker-contract.js";
import { runGitWorkerOperation } from "./git-worker.js";
import { pruneMapToMaxSize } from "./map-size.js";

const MAX_CACHED_CHECKOUTS = 1_000;
const log = createSubsystemLogger("git/read");

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
  pending: boolean;
  value?: T;
};

function gitEnvironmentKey(input: unknown): string {
  return JSON.stringify([
    input,
    Object.entries(process.env)
      .filter(([key]) => /^(GIT_|HOME$|XDG_CONFIG_HOME$|PATH$|SUDO_UID$)/i.test(key))
      .toSorted(([left], [right]) => left.localeCompare(right)),
  ]);
}

function createReadCache<Input, Output>(
  load: (input: Input, signal: AbortSignal) => Promise<Output>,
  freshness: number | { milliseconds: number; joinPending?: true; versionedMilliseconds?: number },
  revision?: (input: Input, signal: AbortSignal) => Promise<string | null>,
  keyOf: (input: Input) => string = JSON.stringify,
  snapshot?: { empty: () => Output },
  retain: (value: Output) => boolean = () => true,
  maxEntries = MAX_CACHED_CHECKOUTS,
) {
  const freshnessMs = typeof freshness === "number" ? freshness : freshness.milliseconds;
  const joinPending = typeof freshness !== "number" && freshness.joinPending;
  // Versioned reads retain only the current inputs/revision per checkout. LRU
  // eviction and Gateway shutdown own their lifetime, independently of viewers.
  const entries = new Map<string, ReadEntry<Output>>();
  const pending = new Set<ReadEntry<Output>>();
  const revisions = new Map<
    string,
    { controller: AbortController; promise: Promise<string | null> }
  >();
  let refreshTail: Promise<unknown> = Promise.resolve();
  let closed = false;
  const remove = (key: string, entry: ReadEntry<Output>) => {
    if (entries.get(key) === entry) {
      entries.delete(key);
    }
  };
  return {
    async read(input: Input, options: GitReadOptions = {}): Promise<Output> {
      options.signal?.throwIfAborted();
      const key = keyOf(input);
      let currentRevision: string | null | undefined;
      if (revision) {
        // Share only overlapping checks of identical inputs, never a settled revision.
        const revisionInput = gitEnvironmentKey(input);
        let check = revisions.get(revisionInput);
        if (!check) {
          const controller = new AbortController();
          const promise = revision(input, controller.signal).finally(() => {
            revisions.delete(revisionInput);
          });
          check = { controller, promise };
          revisions.set(revisionInput, check);
        }
        currentRevision = await racePromiseWithAbortSignal(
          check.promise,
          options.signal,
          (signal) => toErrorObject(signal.reason, "Git read aborted"),
        );
      }
      const retainedFreshnessMs =
        typeof freshness !== "number" && typeof currentRevision === "string"
          ? (freshness.versionedMilliseconds ?? freshnessMs)
          : freshnessMs;
      const revisionKey = JSON.stringify([input, currentRevision]);
      options.signal?.throwIfAborted();
      if (closed) {
        throw new Error("Git reads are unavailable while the Gateway is restarting");
      }
      let entry = entries.get(key);
      if (
        (options.refresh && currentRevision === null) ||
        !entry ||
        entry.revision !== revisionKey ||
        (entry.expiresAt <= Date.now() && (!(snapshot || joinPending) || !entry.pending))
      ) {
        if (snapshot && pending.size >= MAX_CACHED_CHECKOUTS) {
          return entry?.value ?? snapshot.empty();
        }
        const previousRefresh = refreshTail;
        const controller = new AbortController();
        const next: ReadEntry<Output> = {
          revision: revisionKey,
          expiresAt:
            retainedFreshnessMs === 0
              ? Number.POSITIVE_INFINITY
              : Date.now() +
                (currentRevision === null
                  ? Math.min(retainedFreshnessMs, 75_000)
                  : retainedFreshnessMs),
          controller,
          pending: true,
          value: entry?.value,
          promise: Promise.resolve().then(() =>
            snapshot
              ? runWithGatewayDetachedWorkContinuation(async () => {
                  // Serialize display batches; the worker probes four checkouts concurrently.
                  await previousRefresh;
                  controller.signal.throwIfAborted();
                  return load(input, controller.signal);
                }, "runtime:project-discovery")
              : load(input, controller.signal),
          ),
        };
        pending.add(next);
        next.promise = next.promise.then(
          (value) => {
            next.pending = false;
            pending.delete(next);
            controller.signal.throwIfAborted();
            if (snapshot) {
              next.value = value;
              next.expiresAt = Date.now() + freshnessMs;
            }
            if (retainedFreshnessMs === 0 || !retain(value)) {
              remove(key, next);
            }
            return value;
          },
          (error: unknown) => {
            next.pending = false;
            pending.delete(next);
            if (snapshot) {
              next.expiresAt = Date.now() + freshnessMs;
            } else {
              next.expiresAt = 0;
              remove(key, next);
            }
            throw error;
          },
        );
        if (snapshot) {
          refreshTail = next.promise.catch(() => {
            if (!controller.signal.aborted) {
              log.warn(
                "Repository discovery refresh failed; retaining the previous project snapshot",
              );
            }
          });
        }
        // Replace at admission. An older completion updates only its own entry.
        entry = next;
      }
      entries.delete(key);
      entries.set(key, entry);
      pruneMapToMaxSize(entries, maxEntries);
      // Viewer cancellation stops waiting, not the shared bounded read.
      return snapshot
        ? (entry.value ?? snapshot.empty())
        : racePromiseWithAbortSignal(entry.promise, options.signal, (signal) =>
            toErrorObject(signal.reason, "Git read aborted"),
          );
    },
    async close(): Promise<void> {
      closed = true;
      for (const { controller } of revisions.values()) {
        controller.abort();
      }
      const retiring = [...pending];
      for (const entry of retiring) {
        entry.expiresAt = 0;
        entry.controller.abort();
      }
      entries.clear();
      await Promise.allSettled([
        ...Array.from(revisions.values(), (check) => check.promise),
        ...retiring.map((entry) => entry.promise),
      ]);
    },
  };
}

function createReadCaches() {
  const comparisons = createReadCache<
    GitWorkerOperations["pull-request.branch-comparison"]["input"],
    GitWorkerOperations["pull-request.branch-comparison"]["output"]
  >(
    (input, signal) =>
      runGitWorkerOperation({ type: "pull-request.branch-comparison", input }, { signal }),
    Number.POSITIVE_INFINITY,
    (input, signal) =>
      runGitWorkerOperation(
        { type: "checkout.revision", input: { ...input, scope: "refs" } },
        { signal },
      ),
    (input) => input.root,
    undefined,
    // Missing objects can arrive without moving refs; retry incomplete comparisons.
    (value) => value.complete,
  );
  return {
    comparisons,
    identities: createReadCache(
      (input: GitReadOperations["repository.identities"]["input"], signal) =>
        runGitWorkerOperation({ type: "repository.identities", input }, { signal }),
      // Display-only discovery never delays a listing, even on a cold checkout set.
      // External Git config/relocations have no complete revision: refresh in the background
      // after one minute; checkout-set/environment changes select an independent snapshot.
      60_000,
      undefined,
      gitEnvironmentKey,
      { empty: () => [] },
    ),
    context: createReadCache(
      (input: GitReadOperations["checkout.context"]["input"], signal) =>
        runGitWorkerOperation({ type: "checkout.context", input }, { signal }),
      Number.POSITIVE_INFINITY,
      (input, signal) =>
        runGitWorkerOperation(
          { type: "checkout.revision", input: { root: input.root, scope: "context" } },
          { signal },
        ),
      (input) => input.root,
    ),
    branchFacts: createReadCache(
      async (input: GitReadOperations["pull-request.branch-facts"]["input"], signal) => {
        try {
          const { refreshIndex: _, ...comparisonInput } = input;
          const comparison = await comparisons.read(comparisonInput, { signal, refresh: true });
          return await runGitWorkerOperation(
            { type: "pull-request.branch-facts", input: { ...input, comparison } },
            { signal },
          );
        } catch {
          signal.throwIfAborted();
          log.warn(
            "PR comparison unavailable; fetch repository history and retry. Dependent comparisons skipped.",
          );
          return { creatable: false, stats: null };
        }
      },
      // Unstaged edits do not advance the ref/index revision.
      5 * 60_000,
      (input, signal) =>
        runGitWorkerOperation(
          {
            type: "checkout.revision",
            input: { ...input, scope: "worktree" },
          },
          { signal },
        ),
      (input) => input.root,
    ),
    diff: createReadCache(
      (input: GitReadOperations["checkout.diff"]["input"], signal) =>
        runGitWorkerOperation({ type: "checkout.diff", input }, { signal }),
      { milliseconds: 0, versionedMilliseconds: Number.POSITIVE_INFINITY },
      (input, signal) =>
        runGitWorkerOperation(
          { type: "checkout.revision", input: { root: input.cwd, scope: "diff" } },
          { signal },
        ),
      undefined,
      undefined,
      (value) => !value.unavailableReason,
      // Full results may retain 1.5 MB of patches each.
      32,
    ),
    diffSummary: createReadCache(
      (input: GitReadOperations["checkout.diff"]["input"], signal) =>
        runGitWorkerOperation({ type: "checkout.diff", input }, { signal }),
      // Visible clients share this short-lived summary; never duplicate a slow scan.
      {
        milliseconds: 10_000,
        joinPending: true,
        versionedMilliseconds: Number.POSITIVE_INFINITY,
      },
      (input, signal) =>
        runGitWorkerOperation(
          { type: "checkout.revision", input: { root: input.cwd, scope: "diff" } },
          { signal },
        ),
      undefined,
      undefined,
      (value) => !value.unavailableReason,
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
  const { context, branchFacts, diff, diffSummary, branches, baseline, identities } =
    (state.caches ??= createReadCaches());
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
      // Transport truncation mutates these envelopes, not the shared patch strings.
      return (operation.input.summaryOnly ? diffSummary : diff)
        .read(operation.input, options)
        .then((value) => ({
          ...value,
          files: value.files.map((file) => ({ ...file })),
          ...(value.commits ? { commits: value.commits.map((commit) => ({ ...commit })) } : {}),
          ...(value.mergeBase ? { mergeBase: { ...value.mergeBase } } : {}),
        }));
    case "repository.branches":
      return branches.read(operation.input, options);
    case "checkout.baseline":
      return baseline.read(operation.input, options);
  }
  throw new Error("Unsupported Git read operation");
}

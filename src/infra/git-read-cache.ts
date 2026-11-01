import { performance } from "node:perf_hooks";
import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { runWithGatewayDetachedWorkContinuation } from "../process/gateway-work-admission.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { monotonicNow } from "../shared/monotonic-time.js";
import { racePromiseWithAbortSignal } from "./abort-signal.js";
import {
  addDiffReadDurations,
  startDiffReadTiming,
  type DiffReadCacheMissReason,
  type DiffReadTiming,
} from "./diff-read-timing.js";
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
  diffTiming?: DiffReadTiming;
  /** Bound cold diff waits; share completed cold results for one second. */
  poll?: boolean;
};

type ReadEntry<T> = {
  revision: string | null | undefined;
  expiresAt: number;
  promise: Promise<T>;
  controller: AbortController;
  pending: boolean;
  retryAt?: number;
  timing?: DiffReadTiming;
  value?: T;
};

type ReadSlot<T> = {
  entry?: ReadEntry<T>;
  poll?: {
    promise: Promise<T>;
    controller: AbortController;
    pending: boolean;
    expiresAt: number;
  };
};

function gitEnvironment() {
  return Object.keys(process.env)
    .filter((key) => /^(GIT_|HOME$|XDG_CONFIG_HOME$|PATH$|SUDO_UID$)/i.test(key))
    .toSorted((left, right) => left.localeCompare(right))
    .map((key) => [key, process.env[key]]);
}

function diffRevisionMissReason(
  previous: ReadEntry<unknown>["revision"],
  current: ReadEntry<unknown>["revision"],
): DiffReadCacheMissReason {
  try {
    const before: Record<string, unknown> | null = JSON.parse(previous ?? "null");
    const after: Record<string, unknown> | null = JSON.parse(current ?? "null");
    if (before && after) {
      for (const [component, reason] of [
        ["head", "revision-changed-head"],
        ["index", "revision-changed-index"],
        ["untrackedSet", "revision-changed-untracked-set"],
        ["worktreeMtime", "revision-changed-worktree-mtime"],
      ] as const) {
        if (before[component] !== after[component]) {
          return reason;
        }
      }
    }
  } catch {
    // Non-component revisions still invalidate normally and use the bounded fallback.
  }
  return "revision-changed-metadata";
}

function createReadCache<Input, Output>(
  load: (
    input: Input,
    signal: AbortSignal,
    timing?: DiffReadTiming,
    preparedRevision?: GitReadOperations["checkout.revision"]["output"],
  ) => Promise<Output>,
  freshness: number | { milliseconds: number; joinPending?: true },
  revision?: (input: Input, previous?: Output) => GitReadOperations["checkout.revision"]["input"],
  snapshot?: { empty: () => Output },
  // A numeric result retains an unavailable response until its next probe.
  retain: (value: Output) => boolean | number = () => true,
  maxEntries = MAX_CACHED_CHECKOUTS,
  polling?: { empty: () => Output },
) {
  const freshnessMs = typeof freshness === "number" ? freshness : freshness.milliseconds;
  const joinPending = typeof freshness !== "number" && freshness.joinPending;
  // Versioned reads retain the current revision per request shape. LRU
  // eviction and Gateway shutdown own their lifetime, independently of viewers.
  const entries = new Map<string, ReadSlot<Output>>();
  // Retain only the most recent capacity evictions; older misses become cold again.
  const evicted = new Map<string, true>();
  const pending = new Set<ReadEntry<Output>>();
  const revisions = new Map<
    string,
    {
      controller: AbortController;
      promise: Promise<GitReadOperations["checkout.revision"]["output"]>;
      timing?: DiffReadTiming;
    }
  >();
  let refreshTail: Promise<unknown> = Promise.resolve();
  let closed = false;
  let pollCount = 0;
  const releasePoll = (key: string, slot: ReadSlot<Output>) => {
    if (entries.get(key) !== slot || !slot.poll) {
      return;
    }
    delete slot.poll;
    pollCount--;
    if (!slot.entry) {
      entries.delete(key);
    }
  };
  const remove = (key: string, entry: ReadEntry<Output>) => {
    const slot = entries.get(key);
    if (slot?.entry === entry) {
      delete slot.entry;
      if (!slot.poll) {
        entries.delete(key);
      }
    }
  };
  const read = async (
    input: Input,
    options: GitReadOptions = {},
    preparedEnvironment?: ReturnType<typeof gitEnvironment>,
    preparedKey?: string,
  ): Promise<Output> => {
    options.signal?.throwIfAborted();
    using completedTiming = polling ? startDiffReadTiming("checkout.diff") : undefined;
    const timing = completedTiming ?? options.diffTiming;
    const validationStarted = timing ? performance.now() : 0;
    const environment = preparedEnvironment ?? gitEnvironment();
    const key = preparedKey ?? JSON.stringify([input, environment]);
    let entry = entries.get(key)?.entry;
    const waitingToRetry = !options.refresh && (entry?.retryAt ?? 0) > monotonicNow();
    let currentRevision = waitingToRetry ? entry!.revision : undefined;
    let preparedRevision: GitReadOperations["checkout.revision"]["output"] | undefined;
    if (revision && !waitingToRetry) {
      // Share only overlapping checks of identical inputs, never a settled revision.
      const revisionInput = revision(input, entry?.value);
      const revisionKey = JSON.stringify([revisionInput, environment]);
      let check = revisions.get(revisionKey);
      if (!check) {
        const controller = new AbortController();
        const revisionTiming = timing ? { durations: {} } : undefined;
        const promise = runGitWorkerOperation(
          { type: "checkout.revision", input: revisionInput },
          { signal: controller.signal, diffTiming: revisionTiming },
        ).finally(() => {
          revisions.delete(revisionKey);
        });
        check = { controller, promise, timing: revisionTiming };
        revisions.set(revisionKey, check);
      }
      preparedRevision = await racePromiseWithAbortSignal(check.promise, options.signal, (signal) =>
        toErrorObject(signal.reason, "Git read aborted"),
      );
      currentRevision = preparedRevision?.key ?? null;
      if (timing && check.timing) {
        addDiffReadDurations(timing, check.timing);
        timing.revisionUnavailableReason = check.timing.revisionUnavailableReason;
      }
    }
    if (timing) {
      timing.durations["cache-validate"] = performance.now() - validationStarted;
    }
    const retainedFreshnessMs =
      typeof freshness !== "number" && typeof currentRevision === "string"
        ? Number.POSITIVE_INFINITY
        : freshnessMs;
    options.signal?.throwIfAborted();
    if (closed) {
      throw new Error("Git reads are unavailable while the Gateway is restarting");
    }
    entry = entries.get(key)?.entry;
    const previous = entry;
    const wasEvicted = evicted.delete(key);
    let cacheHit = !entry?.pending;
    if (
      (options.refresh && (currentRevision === null || entry?.retryAt !== undefined)) ||
      !entry ||
      entry.revision !== currentRevision ||
      (entry.expiresAt <= monotonicNow() && (!(snapshot || joinPending) || !entry.pending))
    ) {
      if (snapshot && pending.size >= MAX_CACHED_CHECKOUTS) {
        return entry?.value ?? snapshot.empty();
      }
      cacheHit = false;
      const loadTiming = timing ? { durations: {} } : undefined;
      const previousRefresh = refreshTail;
      const controller = new AbortController();
      const next: ReadEntry<Output> = {
        revision: currentRevision,
        expiresAt:
          retainedFreshnessMs === 0
            ? Number.POSITIVE_INFINITY
            : monotonicNow() +
              (currentRevision === null
                ? Math.min(retainedFreshnessMs, 75_000)
                : retainedFreshnessMs),
        controller,
        pending: true,
        timing: loadTiming,
        value: entry?.value,
        promise: Promise.resolve().then(() =>
          snapshot
            ? runWithGatewayDetachedWorkContinuation(async () => {
                // Serialize display batches; the worker probes four checkouts concurrently.
                await previousRefresh;
                controller.signal.throwIfAborted();
                return load(input, controller.signal, loadTiming, preparedRevision);
              }, "runtime:project-discovery")
            : load(input, controller.signal, loadTiming, preparedRevision),
        ),
      };
      pending.add(next);
      next.promise = next.promise.then(
        (value) => {
          next.pending = false;
          pending.delete(next);
          controller.signal.throwIfAborted();
          next.value = value;
          if (snapshot) {
            next.expiresAt = monotonicNow() + freshnessMs;
          }
          const retention = retain(value);
          if (typeof retention === "number") {
            next.retryAt = next.expiresAt = monotonicNow() + retention;
          } else if (retainedFreshnessMs === 0 || !retention) {
            remove(key, next);
          } else if (joinPending && currentRevision === null) {
            // Unversioned summaries already allow this admission-based TTL.
            next.retryAt = next.expiresAt;
          }
          return value;
        },
        (error: unknown) => {
          next.pending = false;
          pending.delete(next);
          if (snapshot) {
            next.expiresAt = monotonicNow() + freshnessMs;
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
    const slot = entries.get(key) ?? {};
    slot.entry = entry;
    entries.delete(key);
    entries.set(key, slot);
    for (const [oldest, candidate] of entries) {
      if (entries.size <= maxEntries) {
        break;
      }
      if (candidate.poll) {
        if (candidate.poll.pending || candidate.poll.expiresAt > monotonicNow()) {
          continue;
        }
        releasePoll(oldest, candidate);
      }
      entries.delete(oldest);
      evicted.set(oldest, true);
    }
    pruneMapToMaxSize(evicted, maxEntries);
    // Viewer cancellation stops waiting, not the shared bounded read.
    const value = snapshot
      ? (entry.value ?? snapshot.empty())
      : await racePromiseWithAbortSignal(entry.promise, options.signal, (signal) =>
          toErrorObject(signal.reason, "Git read aborted"),
        );
    if (timing) {
      timing.outcome = cacheHit ? "cache-hit" : "cache-miss";
      timing.missReason = cacheHit
        ? undefined
        : currentRevision === null
          ? (timing.revisionUnavailableReason ?? "no-revision")
          : !previous
            ? wasEvicted
              ? "evicted"
              : "cold"
            : previous.revision !== currentRevision
              ? diffRevisionMissReason(previous.revision, currentRevision)
              : "pending";
      if (!cacheHit && entry.timing) {
        addDiffReadDurations(timing, entry.timing);
      }
    }
    if (completedTiming && options.diffTiming) {
      addDiffReadDurations(options.diffTiming, completedTiming);
      options.diffTiming.outcome = completedTiming.outcome;
      options.diffTiming.missReason = completedTiming.missReason;
    }
    return value;
  };
  return {
    async read(input: Input, options: GitReadOptions = {}): Promise<Output> {
      options.signal?.throwIfAborted();
      if (closed) {
        throw new Error("Git reads are unavailable while the Gateway is restarting");
      }
      if (!polling || !options.poll) {
        return read(input, options);
      }
      const computing = () => {
        if (options.diffTiming) {
          options.diffTiming.outcome = "cache-miss";
          options.diffTiming.missReason = "pending";
        }
        return polling.empty();
      };
      const environment = gitEnvironment();
      const key = JSON.stringify([input, environment]);
      const slot = entries.get(key) ?? {};
      if (slot.poll && !slot.poll.pending && slot.poll.expiresAt <= monotonicNow()) {
        releasePoll(key, slot);
      }
      let poll = slot.poll;
      if (!poll && slot.entry?.value) {
        return read(input, options, environment, key);
      }
      if (!poll) {
        if (pollCount >= maxEntries) {
          for (const [otherKey, candidate] of entries) {
            if (
              candidate.poll &&
              !candidate.poll.pending &&
              candidate.poll.expiresAt <= monotonicNow()
            ) {
              releasePoll(otherKey, candidate);
            }
          }
        }
        if (pollCount >= maxEntries) {
          return computing();
        }
        const controller = new AbortController();
        const promise = runWithGatewayDetachedWorkContinuation(
          () => read(input, { ...options, signal: controller.signal, diffTiming: undefined }),
          "runtime:checkout-diff",
        );
        poll = { promise, controller, pending: true, expiresAt: Number.POSITIVE_INFINITY };
        const admitted = poll;
        // Fan out both outcomes to reconnecting tabs before the next fresh read.
        const settled = () => {
          admitted.pending = false;
          admitted.expiresAt = monotonicNow() + 1_000;
        };
        void promise.then(settled, settled);
        slot.poll = poll;
        pollCount++;
        entries.set(key, slot);
      }
      let timedOut = false;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const value = await racePromiseWithAbortSignal(
          poll.pending
            ? Promise.race([
                poll.promise,
                new Promise<Output>((resolve) => {
                  // Let short cold reads finish without another client retry interval.
                  timeout = setTimeout(() => {
                    timedOut = true;
                    resolve(computing());
                  }, 2_000);
                }),
              ])
            : poll.promise,
          options.signal,
          (signal) => toErrorObject(signal.reason, "Git read aborted"),
        );
        if (!timedOut && options.diffTiming) {
          options.diffTiming.outcome = "cache-hit";
          options.diffTiming.missReason = undefined;
        }
        return value;
      } finally {
        clearTimeout(timeout);
      }
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
      const polls = Array.from(entries.values()).flatMap((slot) => (slot.poll ? [slot.poll] : []));
      for (const poll of polls) {
        poll.controller.abort();
      }
      entries.clear();
      pollCount = 0;
      evicted.clear();
      await Promise.allSettled([
        ...Array.from(revisions.values(), (check) => check.promise),
        ...retiring.map((entry) => entry.promise),
        ...polls.map((poll) => poll.promise),
      ]);
    },
  };
}

function createDiffReadCache(
  freshness: Parameters<typeof createReadCache>[1],
  maxEntries = MAX_CACHED_CHECKOUTS,
) {
  const revisionInput = (
    input: GitReadOperations["checkout.diff"]["input"],
    previous?: GitReadOperations["checkout.diff"]["output"],
  ): GitReadOperations["checkout.revision"]["input"] => ({
    root: input.cwd,
    scope: "diff",
    summaryOnly: input.summaryOnly === true,
    refreshIndex: input.refreshIndex === true,
    paths: previous?.files
      .flatMap((file) => (file.oldPath ? [file.path, file.oldPath] : [file.path]))
      .toSorted(),
  });
  return createReadCache<
    GitReadOperations["checkout.diff"]["input"],
    GitReadOperations["checkout.diff"]["output"]
  >(
    (input, signal, diffTiming, preparedRevision) =>
      runGitWorkerOperation(
        {
          type: "checkout.diff",
          input: {
            ...input,
            worktreeStatus: preparedRevision?.worktreeStatus,
          },
        },
        { signal, diffTiming },
      ),
    freshness,
    revisionInput,
    undefined,
    (value) => (value.unavailableReason === "not_git" ? 1_000 : !value.unavailableReason),
    maxEntries,
    { empty: () => ({ files: [], additions: 0, deletions: 0, computing: true }) },
  );
}

function createReadCaches() {
  const comparisons = createReadCache<
    GitWorkerOperations["pull-request.branch-comparison"]["input"],
    GitWorkerOperations["pull-request.branch-comparison"]["output"]
  >(
    (input, signal) =>
      runGitWorkerOperation({ type: "pull-request.branch-comparison", input }, { signal }),
    Number.POSITIVE_INFINITY,
    ({ root, branch, defaultBranch }) => ({ root, branch, defaultBranch, scope: "refs" }),
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
      { empty: () => [] },
    ),
    context: createReadCache(
      (input: GitReadOperations["checkout.context"]["input"], signal) =>
        runGitWorkerOperation({ type: "checkout.context", input }, { signal }),
      Number.POSITIVE_INFINITY,
      ({ root }) => ({ root, scope: "context" }),
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
      ({ root, branch, defaultBranch }) => ({ root, branch, defaultBranch, scope: "worktree" }),
    ),
    diff: createDiffReadCache(
      { milliseconds: 0 },
      // Full results may retain 1.5 MB of patches each.
      32,
    ),
    diffSummary: createDiffReadCache(
      // Visible clients share this short-lived summary; never duplicate a slow scan.
      {
        milliseconds: 10_000,
        joinPending: true,
      },
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
  const caches = (state.caches ??= createReadCaches());
  const { context, branchFacts, branches, baseline, identities } = caches;
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
      return readDiff(
        operation.input.summaryOnly ? caches.diffSummary : caches.diff,
        operation.input,
        options,
      );
    case "repository.branches":
      return branches.read(operation.input, options);
    case "checkout.baseline":
      return baseline.read(operation.input, options);
  }
  throw new Error("Unsupported Git read operation");
}

async function readDiff(
  cache: ReturnType<typeof createReadCaches>["diff"],
  input: GitReadOperations["checkout.diff"]["input"],
  options?: GitReadOptions,
) {
  const value = await cache.read(input, options);
  // Transport truncation mutates these envelopes, not the shared patch strings.
  return {
    ...value,
    files: value.files.map((file) => ({ ...file })),
    ...(value.commits ? { commits: value.commits.map((commit) => ({ ...commit })) } : {}),
    ...(value.mergeBase ? { mergeBase: { ...value.mergeBase } } : {}),
  };
}

import nodePath from "node:path";
import { canonicalPathFromExistingAncestor } from "@openclaw/fs-safe/advanced";
import { watch, type WatchOptions, type WatchSubscription } from "@openclaw/fs-safe/watch";
import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import {
  resolveFsObservationMode,
  resolveFsObservationIntervalMs,
} from "../infra/fs-observation-mode.js";
import { isPathInside } from "../infra/path-guards.js";
import { createDeferredCore } from "../shared/deferred.js";
import { resolveIncludeRoots } from "./paths.js";
import {
  admitConfigObservationRoots,
  configObservationEntries,
  configObservationScopes,
} from "./source-file-roots.js";
import { createConfigFileStability } from "./source-file-stability.js";

const WATCHER_RECREATE_BACKOFF_MS = [500, 2000, 5000] as const;
export function createConfigFileAdapter(opts: {
  path: string;
  includedPaths?: readonly string[];
  includeRoots?: readonly string[];
  onChange: () => void;
  onReady?: (isCurrent: () => boolean) => void;
  log: { warn: (message: string) => void; error: (message: string) => void };
}) {
  type Generation = {
    lifetime: AbortController;
    mode: WatchOptions["mode"];
    ready: boolean;
    subscriptions: WatchSubscription[];
    starting: Promise<void>;
    stability: ReturnType<typeof createConfigFileStability>;
    close(): Promise<void>;
  };
  let watcher: Generation | undefined;
  let started = false;
  let stopped = false;
  let acceptedPaths = [...(opts.includedPaths ?? [])];
  const normalizePaths = (paths: readonly string[]) =>
    new Set([opts.path, ...paths].map((entry) => nodePath.resolve(entry)));
  let watchedPaths = normalizePaths(acceptedPaths);
  let primaryTarget: string | undefined;
  let selectionRevision = 0;
  let roots: ReturnType<typeof admitConfigObservationRoots> | undefined;
  const admittedRoots: Parameters<typeof admitConfigObservationRoots>[2] = {
    roots: new Map(),
    canonicalBoundaries: new Map(),
  };
  let retries = 0;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let degradedToPolling = false;
  let status: "active" | "disabled" = "active";
  const retiring = new Set<Promise<void>>();

  const retire = (source: Generation) => {
    const closing = source.close();
    retiring.add(closing);
    // Keep failed retirement visible to stop(), even after it settles.
    void closing.then(
      () => retiring.delete(closing),
      () => {},
    );
    return closing;
  };

  const createWatcher = (replacement: boolean) => {
    if (stopped) {
      return;
    }
    const lifetime = new AbortController();
    let closing: Promise<void> | undefined;
    const next: Generation = {
      lifetime,
      mode: degradedToPolling ? "poll" : resolveFsObservationMode(),
      ready: false,
      subscriptions: [],
      starting: Promise.resolve(),
      stability: createConfigFileStability(
        () => {
          if (!stopped && watcher === next && !lifetime.signal.aborted) {
            opts.onChange();
          }
        },
        (error) => opts.log.warn(`config file stability check failed: ${String(error)}`),
      ),
      close() {
        if (!closing) {
          const done = createDeferredCore();
          closing = done.promise;
          lifetime.abort();
          const settling = next.stability.close();
          const closes = new Map<WatchSubscription, Promise<void>>();
          const capture = () => {
            for (const source of next.subscriptions) {
              if (closes.has(source)) {
                continue;
              }
              try {
                closes.set(source, source.close());
              } catch (error) {
                closes.set(
                  source,
                  Promise.reject(toErrorObject(error, "Config observation retirement failed")),
                );
              }
            }
          };
          capture();
          // Attach rejection handlers immediately, including during held startup.
          const admittedCloses = Promise.allSettled([settling, ...closes.values()]);
          void (async () => {
            await Promise.allSettled([next.starting, admittedCloses]);
            capture();
            const results = await Promise.allSettled([settling, ...closes.values()]);
            const errors = results.flatMap((result) =>
              result.status === "rejected" ? [result.reason] : [],
            );
            if (errors.length) {
              throw new AggregateError(errors, "Config observation retirement failed");
            }
          })().then(done.resolve, done.reject);
        }
        return closing;
      },
    };
    watcher = next;
    status = "active";
    const isCurrent = () => !stopped && watcher === next && !lifetime.signal.aborted;
    next.starting = Promise.resolve().then(async () => {
      if (!roots) {
        const admission = admitConfigObservationRoots(
          opts.path,
          opts.includeRoots ?? resolveIncludeRoots(),
          admittedRoots,
          primaryTarget,
        );
        roots = admission;
        void admission.catch(() => {
          if (roots === admission) {
            roots = undefined;
          }
        });
      }
      const admitted = await roots;
      if (!isCurrent()) {
        return;
      }
      primaryTarget ??=
        admitted.find((entry) => entry.primary)?.primary?.target ?? nodePath.resolve(opts.path);
      const desiredPaths = watchedPaths;
      const covered = new Set<string>();
      for (const boundary of admitted) {
        const allEntries = [...configObservationEntries(boundary, desiredPaths)];
        for (const [, absolute] of allEntries) {
          covered.add(absolute);
        }
        for (let offset = 0; offset < allEntries.length; offset += 128) {
          const entries = new Map(allEntries.slice(offset, offset + 128));
          const scopes = await configObservationScopes(
            boundary.authority,
            entries,
            lifetime.signal,
            primaryTarget,
          );
          if (!isCurrent()) {
            return;
          }
          if (entries.size === 0) {
            continue;
          }
          const indirectScopes = new Set(
            scopes
              .filter((scope) => !entries.has(nodePath.normalize(scope.path)))
              .map((scope) => nodePath.normalize(scope.path)),
          );
          const subscription = watch(boundary.authority, {
            scopes,
            mode: next.mode,
            intervalMs: next.mode === "poll" ? resolveFsObservationIntervalMs() : undefined,
            signal: lifetime.signal,
            onInvalidate: (hint) => {
              if (!isCurrent()) {
                return;
              }
              // Bootstrap invalidation is not a file mutation (formerly ignoreInitial).
              // onReady owns the initial read/admission gap; detailed startup changes
              // and later unknown invalidations still follow the ordinary change path.
              if (!next.ready && hint.reason === "reconcile" && !hint.changes?.length) {
                return;
              }
              const relevant = [...entries].filter(
                ([, absolute]) =>
                  !hint.changes ||
                  hint.changes.some((change) => {
                    const changed = nodePath.resolve(boundary.authority.rootDir, change.path);
                    return (
                      changed === absolute ||
                      (change.type === "structural" && isPathInside(changed, absolute))
                    );
                  }),
              );
              if (!relevant.length) {
                return;
              }
              if (
                next.ready &&
                indirectScopes.size > 0 &&
                (!hint.changes ||
                  hint.changes.some(
                    (change) =>
                      change.type === "structural" &&
                      indirectScopes.has(nodePath.normalize(change.path)),
                  ))
              ) {
                opts.onChange();
                if (isCurrent()) {
                  void reconcilePaths([...watchedPaths], true);
                }
                return;
              }
              // Polling and missed-event reconciliation also carry real changed-file facts.
              // Initial/unchanged reconciliation has no detail and cannot reset retries.
              if (
                hint.changes?.length &&
                (hint.reason === "event" || hint.reason === "reconcile")
              ) {
                retries = 0;
              }
              next.stability.dirty(
                relevant.map(([relative]) => ({ root: boundary.authority, relative })),
              );
            },
            onHealth: (health) => {
              if (health.state === "unavailable" && isCurrent()) {
                handleWatcherError(
                  next,
                  health.failure?.error ?? new Error("Config observation unavailable"),
                  health.mode === "events" && health.failure?.operation === "watch",
                );
              }
            },
          });
          // A later scope admission may await I/O while this subscription fails
          // or closes. Consume rejection now, including startup's early exits.
          void subscription.ready.catch(() => {});
          next.subscriptions.push(subscription);
          if (!isCurrent()) {
            return;
          }
        }
      }
      // Rejected candidates can exceed the pinned include boundaries. They
      // never grant authority, and must not retire observation of the config
      // that the operator edits to repair them.
      if (!covered.has(primaryTarget)) {
        throw new Error("Primary config watch path requires source-root admission");
      }
      await Promise.all(next.subscriptions.map((source) => source.ready));
      if (!isCurrent()) {
        return;
      }
      next.ready = true;
      if (replacement) {
        opts.onChange();
      } else {
        opts.onReady?.(isCurrent);
      }
    });
    void next.starting.catch((error: unknown) => {
      if (isCurrent()) {
        handleWatcherError(next, error);
      }
    });
  };

  const handleWatcherError = (source: Generation, error: unknown, eventWatchFailed = false) => {
    if (stopped || watcher !== source) {
      return;
    }
    watcher = undefined;
    const retirement = retire(source);
    // Losing coverage invalidates independently of delayed/failed physical close.
    opts.onChange();
    if (stopped) {
      return;
    }
    void retirement.catch((failure: unknown) => {
      status = "disabled";
      clearTimeout(retryTimer);
      opts.log.error(`config watcher close failed; hot-reload disabled: ${String(failure)}`);
    });
    let backoff = WATCHER_RECREATE_BACKOFF_MS[retries];
    if (backoff === undefined) {
      if (eventWatchFailed && source.mode !== "poll") {
        degradedToPolling = true;
        retries = 0;
        backoff = WATCHER_RECREATE_BACKOFF_MS[0];
        opts.log.warn(
          `config watcher native retries exhausted; degrading to polling mode: ${String(error)}`,
        );
      } else {
        status = "disabled";
        opts.log.error(
          `config hot-reload disabled: watcher failed after ${WATCHER_RECREATE_BACKOFF_MS.length} re-create attempts in ${source.mode === "poll" ? "polling" : "native"} mode: ${String(error)}`,
        );
        return;
      }
    } else {
      retries += 1;
      opts.log.warn(
        `config watcher error; re-creating watcher (attempt ${retries}/${WATCHER_RECREATE_BACKOFF_MS.length} in ${backoff}ms): ${String(error)}`,
      );
    }
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      void retirement.then(
        () => {
          if (!stopped && !watcher) {
            createWatcher(true);
          }
        },
        () => {},
      );
    }, backoff);
  };

  const reconcilePaths = async (paths: readonly string[], changedScope = false) => {
    const revision = ++selectionRevision;
    const nextPaths = normalizePaths(paths);
    const nextPrimary = await canonicalPathFromExistingAncestor(opts.path);
    if (stopped || revision !== selectionRevision) {
      return;
    }
    const changedPrimary = nextPrimary !== primaryTarget;
    if (
      !changedScope &&
      !changedPrimary &&
      nextPaths.size === watchedPaths.size &&
      [...nextPaths].every((path) => watchedPaths.has(path))
    ) {
      return;
    }
    watchedPaths = nextPaths;
    primaryTarget = nextPrimary;
    if (changedPrimary) {
      roots = undefined;
    }
    const previous = watcher;
    if (!previous) {
      return;
    }
    try {
      await retire(previous);
    } catch (error) {
      handleWatcherError(previous, error);
      return;
    }
    // Retirement can be shared by later selections, including a no-op. The
    // generation identity elects one replacement using the latest watchedPaths;
    // an obsolete selection revision must not strand the already-closed owner.
    if (!stopped && watcher === previous) {
      createWatcher(true);
    }
  };

  return {
    start() {
      if (!started && !stopped) {
        started = true;
        createWatcher(false);
      }
    },
    observePaths: (paths: readonly string[]) => reconcilePaths([...acceptedPaths, ...paths]),
    acceptPaths(paths: readonly string[]) {
      acceptedPaths = [...paths];
      return reconcilePaths(acceptedPaths);
    },
    async stop() {
      stopped = true;
      clearTimeout(retryTimer);
      const previous = watcher;
      watcher = undefined;
      if (previous) {
        void retire(previous).catch(() => {});
      }
      const results = await Promise.allSettled(retiring);
      const errors = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (errors.length) {
        throw new AggregateError(errors, "Config watcher shutdown failed");
      }
    },
    status: () => status,
  };
}

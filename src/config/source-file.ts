import nodePath from "node:path";
import { canonicalPathFromExistingAncestor } from "@openclaw/fs-safe/advanced";
import type { Root } from "@openclaw/fs-safe/root";
import {
  watch,
  type WatchOptions,
  type WatchScope,
  type WatchSubscription,
} from "@openclaw/fs-safe/watch";
import { throwSettledAggregate } from "../infra/error-graph-internal.js";
import {
  FS_RECONCILE_MS,
  resolveFsObservationMode,
  resolveFsObservationIntervalMs,
} from "../infra/fs-observation-mode.js";
import { runWithMainThreadTask } from "../infra/main-thread-stall.js";
import { observeOwnedDirectory } from "../infra/owned-directory-observation.js";
import { resolveIncludeRoots } from "./paths.js";
import {
  admitConfigObservationRoots,
  configObservationEntries,
  configObservationScopes,
} from "./source-file-roots.js";
import { createConfigFileStability } from "./source-file-stability.js";

const WATCHER_RECREATE_BACKOFF_MS = [500, 2000, 5000] as const;

type Source = {
  root: Root;
  entries: Map<string, string>;
  scopes: WatchScope[];
  ready: boolean;
  subscription: WatchSubscription;
  events: Map<string, ReturnType<typeof observeOwnedDirectory>>;
};

export function createConfigFileAdapter(opts: {
  path: string;
  includedPaths?: readonly string[];
  onChange: () => void;
  onReady?: (isCurrent: () => boolean) => void;
  log: { warn: (message: string) => void; error: (message: string) => void };
}) {
  type Watcher = {
    lifetime: AbortController;
    mode: WatchOptions["mode"];
    allowPollingRecovery: boolean;
    sources: Map<string, Source>;
    work: Promise<void>;
    ready: boolean;
    replacement: boolean;
    stability: ReturnType<typeof createConfigFileStability>;
    close(): Promise<void>;
  };
  let watcher: Watcher | undefined;
  let started = false;
  let stopped = false;
  let acceptedPaths = [...(opts.includedPaths ?? [])];
  const normalizePaths = (paths: readonly string[]) =>
    new Set([opts.path, ...paths].map((entry) => nodePath.resolve(entry)));
  let watchedPaths = normalizePaths(acceptedPaths);
  let primaryTarget: string | undefined;
  let roots: ReturnType<typeof admitConfigObservationRoots> | undefined;
  const admittedRoots = {
    roots: new Map<string, Promise<Root>>(),
    canonicalBoundaries: new Map<string, Promise<string>>(),
  };
  let retries = 0;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let degradedToPolling = false;
  let status: "active" | "disabled" = "active";
  const retiring = new Set<Promise<void>>();
  const isCurrent = (source: Watcher) =>
    !stopped && watcher === source && !source.lifetime.signal.aborted;
  const stability = () =>
    createConfigFileStability(opts.onChange, (error) =>
      opts.log.warn(`config file stability check failed: ${String(error)}`),
    );

  const retire = (source: Watcher) => {
    const closing = source.close();
    retiring.add(closing);
    // Failed physical retirement remains visible to stop() and prevents recovery.
    void closing.then(
      () => retiring.delete(closing),
      () => {},
    );
    return closing;
  };

  const refreshEvents = (next: Watcher, source: Source) => {
    const directories = new Set(
      next.mode === "poll"
        ? []
        : source.scopes.map((scope) =>
            nodePath.dirname(nodePath.resolve(source.root.rootDir, scope.path)),
          ),
    );
    for (const [directory, events] of source.events) {
      if (!directories.has(directory)) {
        events.close();
        source.events.delete(directory);
      }
    }
    for (const directory of directories) {
      if (source.events.has(directory)) {
        continue;
      }
      // Transport stays beside each file; the wider pinned Root only supplies
      // guarded reconciliation and detects replaced directories and aliases.
      source.events.set(
        directory,
        observeOwnedDirectory(
          directory,
          () => {
            if (isCurrent(next) && source.events.has(directory)) {
              if (!source.events.get(directory)!.isWatching()) {
                handleWatcherError(
                  next,
                  new Error("Config directory notifications unavailable"),
                  true,
                );
                return;
              }
              void source.subscription.reconcile().catch((error: unknown) => {
                if (source.events.has(directory)) {
                  handleWatcherError(next, error);
                }
              });
            }
          },
          { recursive: false, reconcileIntervalMs: FS_RECONCILE_MS },
        ),
      );
      if (!source.events.get(directory)!.isWatching()) {
        handleWatcherError(next, new Error("Config directory notifications unavailable"), true);
        return;
      }
    }
  };

  const refresh = async (next: Watcher) => {
    const desiredPaths = watchedPaths;
    if (!roots) {
      roots = admitConfigObservationRoots(
        opts.path,
        resolveIncludeRoots(),
        admittedRoots,
        primaryTarget,
        desiredPaths,
      );
      const admission = roots;
      void admission.catch(() => {
        if (roots === admission) {
          roots = undefined;
        }
      });
    }
    const admitted = await roots;
    if (!isCurrent(next) || desiredPaths !== watchedPaths) {
      return;
    }
    primaryTarget ??=
      admitted.find((entry) => entry.primary)?.primary?.target ?? nodePath.resolve(opts.path);
    const plans = new Map<string, Pick<Source, "root" | "entries" | "scopes">>();
    for (const boundary of admitted) {
      const entries = [...configObservationEntries(boundary, desiredPaths)];
      for (let offset = 0; offset < entries.length; offset += 128) {
        const selected = new Map(entries.slice(offset, offset + 128));
        const scopes = await configObservationScopes(
          boundary.authority,
          selected,
          next.lifetime.signal,
          primaryTarget,
        );
        if (!isCurrent(next) || desiredPaths !== watchedPaths) {
          return;
        }
        if (selected.size) {
          plans.set(`${boundary.authority.rootDir}\0${offset}`, {
            root: boundary.authority,
            entries: selected,
            scopes,
          });
        }
      }
    }
    if (![...plans.values()].some((plan) => [...plan.entries.values()].includes(primaryTarget!))) {
      throw new Error("Primary config watch path requires source-root admission");
    }
    await next.stability.close();
    if (!isCurrent(next) || desiredPaths !== watchedPaths) {
      return;
    }
    next.stability = stability();
    const updates: Promise<void>[] = [];
    for (const [key, source] of next.sources) {
      if (!plans.has(key)) {
        for (const events of source.events.values()) {
          events.close();
        }
        source.events.clear();
        updates.push(
          source.subscription.close().then(() => {
            next.sources.delete(key);
          }),
        );
      }
    }
    for (const [key, plan] of plans) {
      const existing = next.sources.get(key);
      if (existing) {
        const changed = JSON.stringify(existing.scopes) !== JSON.stringify(plan.scopes);
        Object.assign(existing, plan);
        refreshEvents(next, existing);
        if (changed) {
          existing.ready = false;
          updates.push(
            existing.subscription.setScopes(plan.scopes).then(() => {
              existing.ready = true;
            }),
          );
        }
        continue;
      }
      const source: Source = {
        ...plan,
        events: new Map(),
        ready: false,
        subscription: watch(plan.root, {
          scopes: plan.scopes,
          mode: "poll",
          intervalMs: FS_RECONCILE_MS,
          pollIntervalMs: next.mode === "poll" ? resolveFsObservationIntervalMs() : FS_RECONCILE_MS,
          signal: next.lifetime.signal,
          onInvalidate: (hint) =>
            runWithMainThreadTask("fs-watch:config", () => {
              // Each new baseline has its own read-gap check below.
              if (!source.ready && hint.reason === "reconcile" && !hint.changes?.length) {
                return;
              }
              const indirect = source.scopes.filter(
                (scope) => !source.entries.has(nodePath.normalize(scope.path)),
              );
              if (
                source.ready &&
                indirect.length &&
                (!hint.changes ||
                  hint.changes.some(
                    (change) =>
                      change.type === "structural" &&
                      indirect.some(
                        (scope) =>
                          nodePath.normalize(scope.path) === nodePath.normalize(change.path),
                      ),
                  ))
              ) {
                opts.onChange();
                void reconcilePaths([...watchedPaths], true).catch((error: unknown) =>
                  handleWatcherError(next, error),
                );
                return;
              }
              if (hint.changes?.length) {
                retries = 0;
              }
              next.stability.dirty(
                [...source.entries.keys()].map((relative) => ({ root: source.root, relative })),
              );
            }),
          onHealth: (health) => {
            if (health.state === "unavailable") {
              handleWatcherError(next, health.failure!.error);
            }
          },
        }),
      };
      next.sources.set(key, source);
      refreshEvents(next, source);
      updates.push(
        source.subscription.ready.then(() => {
          source.ready = true;
        }),
      );
    }
    await Promise.all(updates);
    if (!isCurrent(next) || desiredPaths !== watchedPaths) {
      return;
    }
    if (next.ready || next.replacement) {
      opts.onChange();
    } else {
      opts.onReady?.(() => isCurrent(next));
    }
    next.ready = true;
  };

  const enqueueRefresh = (next: Watcher) => {
    next.work = next.work.then(async () => {
      if (isCurrent(next)) {
        await refresh(next);
      }
    });
    return next.work.catch((error: unknown) => handleWatcherError(next, error));
  };

  const createWatcher = (replacement: boolean) => {
    const lifetime = new AbortController();
    let closing: Promise<void> | undefined;
    const next: Watcher = {
      lifetime,
      mode: degradedToPolling ? "poll" : resolveFsObservationMode(),
      allowPollingRecovery: process.env.CHOKIDAR_USEPOLLING === undefined,
      sources: new Map(),
      work: Promise.resolve(),
      ready: false,
      replacement,
      stability: stability(),
      close() {
        if (!closing) {
          lifetime.abort();
          for (const source of next.sources.values()) {
            for (const events of source.events.values()) {
              events.close();
            }
            source.events.clear();
          }
          closing = Promise.allSettled([
            next.work,
            next.stability.close(),
            ...[...next.sources.values()].map((source) => source.subscription.close()),
          ]).then(([, ...results]) => {
            throwSettledAggregate(results, "Config observation retirement failed");
          });
        }
        return closing;
      },
    };
    watcher = next;
    status = "active";
    return enqueueRefresh(next);
  };

  const handleWatcherError = (source: Watcher, error: unknown, eventWatchFailed = false) => {
    if (!isCurrent(source)) {
      return;
    }
    watcher = undefined;
    const retirement = retire(source);
    void retirement
      .catch((failure: unknown) => {
        status = "disabled";
        clearTimeout(retryTimer);
        opts.log.error(`config watcher close failed; hot-reload disabled: ${String(failure)}`);
      })
      .then(() => {
        // Recovery notifies from its initial scan; terminal failure gets one final read.
        if (!stopped && status === "disabled") {
          opts.onChange();
        }
      });
    let backoff = WATCHER_RECREATE_BACKOFF_MS[retries];
    if (backoff === undefined) {
      if (eventWatchFailed && source.mode === "auto" && source.allowPollingRecovery) {
        degradedToPolling = true;
        retries = 0;
        backoff = WATCHER_RECREATE_BACKOFF_MS[0];
        opts.log.warn(
          `config watcher native retries exhausted; degrading to polling mode: ${String(error)}`,
        );
      } else {
        status = "disabled";
        opts.log.error(
          `config hot-reload disabled: watcher failed after ${WATCHER_RECREATE_BACKOFF_MS.length} re-create attempts: ${String(error)}`,
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
            void createWatcher(true);
          }
        },
        () => {},
      );
    }, backoff);
  };

  const reconcilePaths = async (paths: readonly string[], changedScope = false) => {
    const nextPaths = normalizePaths(paths);
    const nextPrimary = await canonicalPathFromExistingAncestor(opts.path);
    if (stopped) {
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
    roots = undefined;
    if (watcher) {
      await enqueueRefresh(watcher);
    }
  };

  return {
    start: async () => {
      if (!started && !stopped) {
        started = true;
        await createWatcher(false);
      }
    },
    whenSettled: () => watcher?.stability.whenSettled() ?? Promise.resolve(),
    observePaths: (paths: readonly string[]) => reconcilePaths([...acceptedPaths, ...paths]),
    acceptPaths: (paths: readonly string[]) => {
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
      throwSettledAggregate(await Promise.allSettled(retiring), "Config watcher shutdown failed");
    },
    status: () => status,
  };
}

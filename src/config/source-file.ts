import nodePath from "node:path";
import chokidar from "chokidar";

const WATCHER_RECREATE_BACKOFF_MS = [500, 2000, 5000] as const;

function resolveUsePolling(degradedToPolling: boolean): boolean {
  const envPoll = process.env.CHOKIDAR_USEPOLLING?.toLowerCase();
  if (envPoll !== undefined) {
    return envPoll !== "false" && envPoll !== "0" && Boolean(envPoll);
  }
  return Boolean(process.env.VITEST) || degradedToPolling;
}

export function createConfigFileAdapter(opts: {
  path: string;
  includedPaths?: readonly string[];
  onChange: () => void;
  onReady?: (isCurrent: () => boolean) => void;
  log: { warn: (message: string) => void; error: (message: string) => void };
}) {
  type Watcher = ReturnType<typeof chokidar.watch>;
  let watcher: Watcher | null = null;
  let started = false;
  let stopped = false;
  let acceptedPaths = [...(opts.includedPaths ?? [])];
  let watchedPaths = new Set([opts.path, ...acceptedPaths].map((path) => nodePath.normalize(path)));
  let retries = 0;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let degradedToPolling = false;
  let status: "active" | "disabled" = "active";
  const closingWatchers = new Map<Watcher, Promise<void>>();

  const closeWatcher = (source: Watcher) => {
    const pending = closingWatchers.get(source);
    if (pending) {
      return pending;
    }
    const closing = source.close();
    closingWatchers.set(source, closing);
    void closing.then(
      () => closingWatchers.delete(source),
      () => closingWatchers.delete(source),
    );
    return closing;
  };

  const createWatcher = (replacement: boolean) => {
    if (stopped) {
      return;
    }
    const next = chokidar.watch([...watchedPaths], {
      depth: 0,
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
      usePolling: resolveUsePolling(degradedToPolling),
    });
    watcher = next;
    status = "active";
    const onChange = (path: string) => {
      if (
        stopped ||
        watcher !== next ||
        closingWatchers.has(next) ||
        !watchedPaths.has(nodePath.normalize(path))
      ) {
        return;
      }
      // Only a file event proves recovery; readiness must not refill the retry budget.
      retries = 0;
      opts.onChange();
    };
    next.on("add", onChange);
    next.on("change", onChange);
    next.on("unlink", onChange);
    next.on("error", (error) => handleWatcherError(next, error));
    next.on("ready", () => {
      if (stopped || watcher !== next || closingWatchers.has(next)) {
        return;
      }
      // Initial add events are suppressed, including edits during replacement.
      if (replacement) {
        opts.onChange();
      } else {
        opts.onReady?.(() => !stopped && watcher === next && !closingWatchers.has(next));
      }
    });
  };

  const handleWatcherError = (source: Watcher, error: unknown) => {
    if (stopped || watcher !== source) {
      return;
    }
    watcher = null;
    void closeWatcher(source).catch(() => {});
    let backoff = WATCHER_RECREATE_BACKOFF_MS[retries];
    if (backoff === undefined) {
      if (!source.options.usePolling && resolveUsePolling(true)) {
        degradedToPolling = true;
        retries = 0;
        backoff = WATCHER_RECREATE_BACKOFF_MS[0];
        opts.log.warn(
          `config watcher native retries exhausted; degrading to polling mode: ${String(error)}`,
        );
      } else {
        status = "disabled";
        const mode = source.options.usePolling ? "polling mode" : "native mode";
        opts.log.error(
          `config hot-reload disabled: watcher failed after ${WATCHER_RECREATE_BACKOFF_MS.length} re-create attempts in ${mode}: ${String(error)}`,
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
      createWatcher(true);
    }, backoff);
  };

  const reconcilePaths = async (paths: readonly string[]) => {
    const nextPaths = new Set([opts.path, ...paths].map((path) => nodePath.normalize(path)));
    if (
      nextPaths.size === watchedPaths.size &&
      [...nextPaths].every((path) => watchedPaths.has(path))
    ) {
      return;
    }
    watchedPaths = nextPaths;
    const previous = watcher;
    if (!previous) {
      return;
    }
    try {
      await closeWatcher(previous);
    } catch (error) {
      handleWatcherError(previous, error);
      return;
    }
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
    observePaths(paths: readonly string[]) {
      return reconcilePaths([...acceptedPaths, ...paths]);
    },
    acceptPaths(paths: readonly string[]) {
      acceptedPaths = [...paths];
      return reconcilePaths(acceptedPaths);
    },
    async stop() {
      stopped = true;
      clearTimeout(retryTimer);
      const previous = watcher;
      watcher = null;
      if (previous) {
        void closeWatcher(previous);
      }
      await Promise.allSettled(closingWatchers.values());
    },
    status: () => status,
  };
}

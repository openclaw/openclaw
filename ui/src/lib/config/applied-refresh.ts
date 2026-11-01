const REFRESH_DELAYS_MS = [250, 750, 1_500, 3_000, 6_000, 30_000] as const;

export type AppliedConfigRefresh = ReturnType<typeof createAppliedConfigRefreshOwner>;

export function createAppliedConfigRefreshOwner(options: {
  shouldRefresh: () => boolean;
  refresh: (isCurrent: () => boolean) => Promise<unknown>;
}) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let attempt = 0;
  let generation = 0;
  let disposed = false;

  const cancel = () => {
    clearTimeout(timer);
    timer = undefined;
    attempt = 0;
    generation += 1;
  };
  const reconcile = () => {
    if (disposed || !options.shouldRefresh()) {
      cancel();
      return;
    }
    if (timer !== undefined) {
      return;
    }
    const delay = REFRESH_DELAYS_MS[Math.min(attempt, REFRESH_DELAYS_MS.length - 1)];
    timer = setTimeout(() => {
      timer = undefined;
      const refreshGeneration = generation;
      attempt = Math.min(attempt + 1, REFRESH_DELAYS_MS.length - 1);
      const settled = () => refreshGeneration === generation && reconcile();
      void options.refresh(() => refreshGeneration === generation).then(settled, settled);
    }, delay);
  };
  return {
    cancel,
    reconcile,
    dispose: () => {
      disposed = true;
      cancel();
    },
  };
}

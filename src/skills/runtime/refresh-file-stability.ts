import { sleepWithAbort } from "../../infra/backoff.js";

export type SkillFileSnapshot = { size: number; mtimeMs: number };

export class SkillFileSampleCloseError extends Error {
  constructor(cause: unknown) {
    super("Skills metadata handle cleanup failed", { cause });
  }
}

/** Settling belongs to Skills parsing; observation readiness is not writer completion. */
export function createSkillFileScheduler(options: {
  stabilityMs: number;
  sample(path: string): Promise<SkillFileSnapshot | undefined>;
  schedule(path: string): void;
  onError(path: string, error: unknown): void;
}) {
  const lifetime = new AbortController();
  let failure: SkillFileSampleCloseError | undefined;
  const pending = new Map<string, { revision: number }>();
  const tasks = new Set<Promise<void>>();
  return {
    schedule(changedPath: string) {
      if (lifetime.signal.aborted) {
        return;
      }
      const previous = pending.get(changedPath);
      if (previous) {
        previous.revision += 1;
        return;
      }
      // Detail overflow stays a domain invalidation, never an unbounded task set.
      if (pending.size >= 1024) {
        options.schedule(changedPath);
        return;
      }
      const current = { revision: 0 };
      pending.set(changedPath, current);
      const work = Promise.resolve()
        .then(async () => {
          for (;;) {
            lifetime.signal.throwIfAborted();
            let revision = current.revision;
            let before = await options.sample(changedPath);
            lifetime.signal.throwIfAborted();
            // A sample can describe the removed predecessor while a recreation
            // hint arrives during its guarded I/O. Resample even when missing.
            if (revision !== current.revision) {
              continue;
            }
            let stable = 0;
            let superseded = false;
            while (before && stable < options.stabilityMs) {
              const interval = Math.min(100, options.stabilityMs - stable);
              await sleepWithAbort(interval, lifetime.signal);
              const sampledRevision = current.revision;
              const next = await options.sample(changedPath);
              lifetime.signal.throwIfAborted();
              if (sampledRevision !== current.revision) {
                superseded = true;
                break;
              }
              if (!next) {
                break;
              }
              stable =
                sampledRevision === revision &&
                next.size === before.size &&
                next.mtimeMs === before.mtimeMs
                  ? stable + interval
                  : 0;
              before = next;
              revision = sampledRevision;
            }
            if (superseded) {
              continue;
            }
            // Stop coalescing before publication: synchronous listeners and the
            // promise-completion microtask may enqueue an independent next edit.
            // The task remains joined separately until publication completes.
            pending.delete(changedPath);
            options.schedule(changedPath);
            return;
          }
        })
        .catch((error: unknown) => {
          const cancelled =
            lifetime.signal.aborted && error instanceof Error && error.name === "AbortError";
          if (!cancelled) {
            // Sampling loss is not failed retirement. Only the sample owner can
            // identify an actual descriptor cleanup failure after joining its I/O.
            if (error instanceof SkillFileSampleCloseError) {
              failure ??= error;
            }
            if (!lifetime.signal.aborted) {
              options.onError(changedPath, error);
            }
          }
        })
        .finally(() => {
          if (pending.get(changedPath) === current) {
            pending.delete(changedPath);
          }
          tasks.delete(work);
        });
      tasks.add(work);
    },
    async close() {
      lifetime.abort();
      await Promise.all(tasks);
      if (failure !== undefined) {
        throw failure;
      }
    },
  };
}

import { AsyncLocalStorage } from "node:async_hooks";
import { registerSignalExitFinalizer } from "../cli/signal-exit-barrier.js";
import { createDeferredCore } from "../shared/deferred.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

export type RuntimeWorkerGeneration = {
  resolve(url: URL): URL;
  retain(owner: object, close: () => Promise<void>): void;
};

type GenerationScope = { generation?: RuntimeWorkerGeneration };
const scope = resolveGlobalSingleton(
  Symbol.for("openclaw.runtimeWorkerGeneration"),
  () => new AsyncLocalStorage<GenerationScope>(),
);
/** Capture before queues or detached pool contexts discard the caller's scope. */
export function captureRuntimeWorkerSource(url: URL): {
  moduleUrl: URL;
  runtimeGeneration?: RuntimeWorkerGeneration;
} {
  const generation = scope.getStore()?.generation;
  const bound = generation?.resolve(url);
  return bound && bound.href !== url.href
    ? { moduleUrl: bound, runtimeGeneration: generation }
    : { moduleUrl: url };
}

export async function withRuntimeWorkerGeneration<T>(
  operation: (bind: (resolve: (url: URL) => URL) => void) => Promise<T>,
  release: (signal: AbortSignal, beginRemoval: () => void) => Promise<void>,
  retainedDirectory?: (reason: string, immediate?: boolean) => string | undefined,
): Promise<T> {
  const current: GenerationScope = {};
  const resources = new Map<object, () => Promise<void>>();
  let closing = false;
  let released = false;
  let removalStarted = false;
  const retirement = new AbortController();
  const { promise: retained, resolve: stopWaiting } = createDeferredCore();
  return await scope.run(current, async () => {
    let outcome: { value: T } | { error: unknown };
    let settlement: Promise<void> | undefined;
    const settleGeneration = () => {
      closing = true;
      return (settlement ??= Promise.race([
        (async () => {
          const settled = await Promise.allSettled(
            [...resources.values()].map((close) => Promise.resolve().then(close)),
          );
          // Deadline expiry is not worker settlement. A late close must not grant
          // permission to retire the projection after the process outcome was forced.
          if (retirement.signal.aborted) {
            return;
          }
          const failures = settled.flatMap((result) =>
            result.status === "rejected" ? [result.reason] : [],
          );
          if (failures.length) {
            const reason =
              "retained updater workers did not settle; keep it until the workers stop";
            const directory = retainedDirectory?.(reason);
            throw new AggregateError(
              failures,
              "Retained updater workers did not settle" +
                (directory ? `. Runtime retained at ${directory}: ${reason}.` : ""),
            );
          }
          await release(retirement.signal, () => {
            removalStarted = true;
          });
          released = !retirement.signal.aborted;
        })(),
        retained,
      ]));
    };
    // Signal owners drain mutation/recovery barriers before retiring worker code.
    const unregister = registerSignalExitFinalizer(settleGeneration, () => {
      // Once removal starts, exit must join it to avoid leaving a partial tree.
      if (released || removalStarted || retirement.signal.aborted) {
        return;
      }
      closing = true;
      retirement.abort();
      try {
        retainedDirectory?.(
          "retained runtime cleanup did not settle before the CLI exit deadline; keep it until the workers stop",
          true,
        );
      } finally {
        stopWaiting();
      }
    });
    try {
      outcome = {
        value: await operation((resolve) => {
          if (closing || current.generation) {
            throw new Error("The updater already retained its worker generation");
          }
          current.generation = Object.freeze({
            resolve(url: URL) {
              if (closing) {
                throw new Error("The updater's retained worker generation is closing");
              }
              return resolve(url);
            },
            retain(owner: object, close: () => Promise<void>) {
              if (closing) {
                throw new Error("The updater's retained worker generation is closing");
              }
              resources.set(owner, close);
            },
          });
        }),
      };
    } catch (error) {
      outcome = { error };
    }
    try {
      await settleGeneration();
    } catch (error) {
      if ("error" in outcome) {
        throw new AggregateError(
          [outcome.error, error],
          "Update and retained runtime cleanup failed",
          { cause: error },
        );
      }
      throw error;
    } finally {
      unregister();
    }
    if ("error" in outcome) {
      throw outcome.error;
    }
    return outcome.value;
  });
}

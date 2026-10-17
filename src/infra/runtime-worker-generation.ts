import { AsyncLocalStorage } from "node:async_hooks";
import { raceWithTimeout } from "../../packages/retry/src/index.js";
import { registerSignalExitFinalizer } from "../cli/signal-exit-barrier.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

export type RuntimeWorkerGeneration = {
  resolve(url: URL): URL;
  /** Join accepted work before native termination; a slow close warning never releases custody. */
  retain(owner: object, settle: () => Promise<void | (() => Promise<void>)>): void;
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
  release: () => Promise<void>,
  retainedDirectory?: (reason: string) => string | undefined,
): Promise<T> {
  const current: GenerationScope = {};
  const resources = new Map<object, Parameters<RuntimeWorkerGeneration["retain"]>[1]>();
  return await scope.run(current, async () => {
    let outcome: { value: T } | { error: unknown };
    let settlement: Promise<void> | undefined;
    const settleGeneration = () => {
      return (settlement ??= (async () => {
        const settled = await Promise.allSettled(
          [...resources.values()].map((settle) => Promise.resolve().then(settle)),
        );
        const failures = settled.flatMap((result) =>
          result.status === "rejected" ? [result.reason] : [],
        );
        const terminate = settled.flatMap((result) =>
          result.status === "fulfilled" && result.value ? [result.value] : [],
        );
        const termination = Promise.allSettled(
          terminate.map((close) => Promise.resolve().then(close)),
        );
        const observed = await raceWithTimeout(termination, 10_000, () => undefined);
        if (!observed) {
          retainedDirectory?.(
            "retained updater worker termination is still pending after settlement; waiting for native retirement before releasing the runtime",
          );
        }
        // The grace period bounds diagnostics, not ownership. Even a sibling
        // settlement failure must join the native retirement already accepted.
        const terminated = observed ?? (await termination);
        if (failures.length) {
          const reason = "retained updater workers did not settle; keep it until the workers stop";
          const directory = retainedDirectory?.(reason);
          throw new AggregateError(
            failures,
            "Retained updater workers did not settle" +
              (directory ? `. Runtime retained at ${directory}: ${reason}.` : ""),
          );
        }
        if (terminated.some((result) => result.status === "rejected")) {
          retainedDirectory?.(
            "retained updater worker termination failed after settlement; retry openclaw update cleanup after this process exits",
          );
          return;
        }
        await release();
      })());
    };
    // Signal owners drain mutation/recovery barriers before retiring worker code.
    const unregister = registerSignalExitFinalizer(settleGeneration);
    try {
      outcome = {
        value: await operation((resolve) => {
          current.generation = Object.freeze({
            resolve,
            retain(owner: object, settle: Parameters<RuntimeWorkerGeneration["retain"]>[1]) {
              resources.set(owner, settle);
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

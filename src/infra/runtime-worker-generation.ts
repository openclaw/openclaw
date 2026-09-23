import { AsyncLocalStorage } from "node:async_hooks";
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
  release: () => Promise<void>,
  retainedDirectory?: () => string | undefined,
): Promise<T> {
  const current: GenerationScope = {};
  const resources = new Map<object, () => Promise<void>>();
  let closing = false;
  return await scope.run(current, async () => {
    let outcome: { value: T } | { error: unknown };
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
    closing = true;
    const settled = await Promise.allSettled([...resources.values()].map((close) => close()));
    const failures = settled.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (failures.length) {
      const directory = retainedDirectory?.();
      throw new AggregateError(
        [...("error" in outcome ? [outcome.error] : []), ...failures],
        "Retained updater workers did not settle" +
          (directory ? `. Runtime retained at ${directory}; keep it until the workers stop.` : ""),
      );
    }
    await release();
    if ("error" in outcome) {
      throw outcome.error;
    }
    return outcome.value;
  });
}

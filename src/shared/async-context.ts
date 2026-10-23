import { AsyncLocalStorage } from "node:async_hooks";
import { resolveGlobalSingleton } from "./global-singleton.js";

type Context = Readonly<Record<symbol, unknown>>;

// Runtime chunks share the carrier; each owner controls only its own field.
const context = resolveGlobalSingleton(
  Symbol.for("openclaw.asyncContext"),
  () => new AsyncLocalStorage<Context | undefined>(),
);

/** A field in the immutable async frame, retaining its owner's value by reference. */
export class AsyncContext<T> {
  constructor(private readonly key: symbol) {}

  getStore(): T | undefined {
    // SAFETY: The key belongs to this typed owner; the carrier never interprets values.
    return context.getStore()?.[this.key] as T | undefined;
  }

  run<R>(value: T | undefined, run: () => R): R {
    const prior = context.getStore();
    const priorValue = prior?.[this.key];
    if (Object.is(priorValue, value)) {
      return run();
    }
    const entered = Object.freeze({ ...prior, [this.key]: value });
    context.enterWith(entered);
    try {
      return run();
    } finally {
      const current = context.getStore();
      // Native run restores its own value without undoing a sibling's enterWith.
      context.enterWith(
        current === entered ? prior : Object.freeze({ ...current, [this.key]: priorValue }),
      );
    }
  }

  exit<R>(run: () => R): R {
    return this.run(undefined, run);
  }

  /** Used by the single-copy runner, which owns restoration of the entire frame. */
  enterWith(value: T | undefined): void {
    context.enterWith(Object.freeze({ ...context.getStore(), [this.key]: value }));
  }
}

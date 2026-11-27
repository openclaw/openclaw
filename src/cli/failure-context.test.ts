import { AsyncLocalStorage } from "node:async_hooks";
import { expect, it, vi } from "vitest";
import { readGlobalSingleton } from "../shared/global-singleton.js";
import { installProcessFailureListener, withCliFailureContext } from "./failure-context.js";

it.each(["uncaughtException", "unhandledRejection"] as const)(
  "routes %s to the active invocation and uses the latest reporter after cleanup",
  async (event) => {
    const key = Symbol.for(`openclaw.processFailureListener.${event}`);
    const previous = readGlobalSingleton(key) as { handle: (reason: unknown) => void } | undefined;
    const previousHandler = previous?.handle;
    const before = process.listeners(event);
    const first = vi.fn();
    const second = vi.fn();
    const listener = installProcessFailureListener(event, first);
    const inner = new Error("inner");
    const outer = new Error("outer");
    const late = new Error("late");
    const report = (error: Error) => {
      if (event === "uncaughtException") {
        listener(error, "uncaughtException");
      } else {
        listener(error, Promise.resolve());
      }
    };
    try {
      const reportLate = await withCliFailureContext(async () => {
        expect(installProcessFailureListener(event, first)).toBe(listener);
        const resume = AsyncLocalStorage.snapshot();
        await withCliFailureContext(async () => {
          expect(installProcessFailureListener(event, second)).toBe(listener);
          report(inner);
        });
        report(outer);
        return () => resume(() => report(late));
      });
      reportLate();
      expect(first.mock.calls).toEqual([[outer]]);
      expect(second.mock.calls).toEqual([[inner], [late]]);
      expect(process.listeners(event).filter((entry) => entry === listener)).toHaveLength(1);
    } finally {
      if (previousHandler) {
        installProcessFailureListener(event, previousHandler);
      } else {
        Reflect.deleteProperty(globalThis, key);
      }
      if (!before.includes(listener)) {
        process.off(event, listener);
      }
    }
  },
);

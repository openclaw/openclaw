import { AsyncLocalStorage, executionAsyncId } from "node:async_hooks";
import { describe, expect, it } from "vitest";
import { runWithAsyncStore } from "./async-store.js";

describe("runWithAsyncStore", () => {
  it("restores unset, default, and nested values after return or throw", () => {
    const fallback = { name: "default" };
    const storage = new AsyncLocalStorage<object | undefined>({ defaultValue: fallback });
    const unrelated = new AsyncLocalStorage<string>();
    const unset = new AsyncLocalStorage<string>();
    const value = { name: "outer" };
    const failure = new Error("callback failed");

    unrelated.run("caller", () => {
      expect(
        runWithAsyncStore(storage, value, () => {
          expect(storage.getStore()).toBe(value);
          expect(unrelated.getStore()).toBe("caller");
          expect(() =>
            runWithAsyncStore(storage, undefined, () => {
              expect(storage.getStore()).toBeUndefined();
              unrelated.enterWith("changed by throwing callback");
              unset.enterWith("set by throwing callback");
              throw failure;
            }),
          ).toThrow(failure);
          expect(storage.getStore()).toBe(value);
          expect(unrelated.getStore()).toBe("caller");
          expect(unset.getStore()).toBeUndefined();
          unrelated.enterWith("changed by returning callback");
          unset.enterWith("set by returning callback");
          return 42;
        }),
      ).toBe(42);
      expect(storage.getStore()).toBe(fallback);
      expect(unrelated.getStore()).toBe("caller");
      expect(unset.getStore()).toBeUndefined();
    });
    expect(unrelated.getStore()).toBeUndefined();
    expect(() =>
      runWithAsyncStore(storage, value, () => {
        throw failure;
      }),
    ).toThrow(failure);
    expect(storage.getStore()).toBe(fallback);
  });

  it("inherits into awaited and detached continuations without leaking to siblings", async () => {
    const storage = new AsyncLocalStorage<string>();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let detached!: Promise<string | undefined>;
    const first = runWithAsyncStore(storage, "first", async () => {
      detached = gate.then(() => storage.getStore());
      await gate;
      return storage.getStore();
    });
    const second = runWithAsyncStore(storage, "second", async () => {
      await gate;
      return storage.getStore();
    });
    expect(storage.getStore()).toBeUndefined();
    release();
    expect(await Promise.all([first, second, detached])).toEqual(["first", "second", "first"]);
    expect(storage.getStore()).toBeUndefined();
  });

  it("leaves same-value reentry in the current async resource", () => {
    const storage = new AsyncLocalStorage<object>();
    const value = {};
    runWithAsyncStore(storage, value, () => {
      const resource = executionAsyncId();
      runWithAsyncStore(storage, value, () => {
        expect(storage.getStore()).toBe(value);
        expect(executionAsyncId()).toBe(resource);
      });
    });
  });
});

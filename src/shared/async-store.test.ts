import { AsyncLocalStorage, AsyncResource, executionAsyncId } from "node:async_hooks";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { runWithAsyncStore } from "./async-store.js";

describe("runWithAsyncStore", () => {
  it("reuses the entry callback while overlapping calls and continuations retain their stores", async () => {
    const storage = new AsyncLocalStorage<object>();
    const values = [
      { plugin: "first", generation: 1 },
      { plugin: "second", generation: 2 },
    ];
    const gate = createDeferred();
    const detached: Promise<object | undefined>[] = [];
    const scoped = vi.spyOn(AsyncResource.prototype, "runInAsyncScope");
    try {
      const calls = values.map((value) =>
        runWithAsyncStore(storage, value, async () => {
          expect(storage.getStore()).toBe(value);
          detached.push(gate.promise.then(() => storage.getStore()));
          await gate.promise;
          return storage.getStore();
        }),
      );
      const callbacks = scoped.mock.calls.map(([callback]) => callback);
      expect(storage.getStore()).toBeUndefined();
      gate.resolve();
      const results = await Promise.all(calls);
      const detachedResults = await Promise.all(detached);
      for (const [index, value] of values.entries()) {
        expect(results[index]).toBe(value);
        expect(detachedResults[index]).toBe(value);
      }
      expect(storage.getStore()).toBeUndefined();
      expect(callbacks).toHaveLength(2);
      expect(new Set(callbacks).size).toBe(1);
    } finally {
      gate.resolve();
      scoped.mockRestore();
    }
  });

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

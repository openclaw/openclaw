import { AsyncLocalStorage, AsyncResource, executionAsyncId } from "node:async_hooks";
import { describe, expect, it } from "vitest";
import { AsyncContext } from "./async-context.js";
import { runWithAsyncStore } from "./async-store.js";
import { createDeferredCore } from "./deferred.js";

describe("AsyncContext", () => {
  it("restores only the selected field across nesting, clearing, and throws", () => {
    const request = new AsyncContext<{ active: boolean }>(Symbol("request"));
    const trace = new AsyncContext<string>(Symbol("trace"));
    const owner = { active: true };
    const failure = new Error("child failed");
    request.run(owner, () => {
      trace.run("outer", () => {
        expect(() =>
          request.exit(() => {
            expect(request.getStore()).toBeUndefined();
            expect(trace.getStore()).toBe("outer");
            trace.run("child", () => {
              expect(trace.getStore()).toBe("child");
              throw failure;
            });
          }),
        ).toThrow(failure);
        expect(request.getStore()).toBe(owner);
        expect(trace.getStore()).toBe("outer");
        request.getStore()!.active = false;
      });
      expect(trace.getStore()).toBeUndefined();
    });
    expect(owner.active).toBe(false);
    expect(request.getStore()).toBeUndefined();
  });

  it("inherits into continuations while captured owners preserve the invoking context", async () => {
    const owner = new AsyncContext<string>(Symbol("owner"));
    const authority = new AsyncContext<string>(Symbol("authority"));
    const gate = createDeferredCore();
    const detachedRoot = new AsyncResource("test-root");
    let detached!: Promise<unknown>;
    let captured!: () => [string | undefined, string | undefined];
    const first = authority.run("first-authority", () =>
      owner.run("first", async () => {
        const value = owner.getStore();
        captured = () => owner.run(value, () => [owner.getStore(), authority.getStore()]);
        detached = gate.promise.then(() => [owner.getStore(), authority.getStore()]);
        expect(detachedRoot.runInAsyncScope(() => owner.getStore())).toBeUndefined();
        await gate.promise;
        return owner.getStore();
      }),
    );
    const second = authority.run("second-authority", () =>
      owner.run("second", async () => {
        await gate.promise;
        expect(captured()).toEqual(["first", "second-authority"]);
        return owner.getStore();
      }),
    );
    gate.resolve();
    expect(await Promise.all([first, second, detached])).toEqual([
      "first",
      "second",
      ["first", "first-authority"],
    ]);
    expect(owner.getStore()).toBeUndefined();
    expect(authority.getStore()).toBeUndefined();
    detachedRoot.emitDestroy();
  });

  it("preserves native run and single-copy runner isolation of unrelated native stores", () => {
    const field = new AsyncContext<string>(Symbol("field"));
    const sibling = new AsyncContext<string>(Symbol("sibling"));
    const native = new AsyncLocalStorage<string>();
    const root = new AsyncResource("test-root");
    root.runInAsyncScope(() => {
      field.run("outer", () => {
        sibling.enterWith("survives return");
      });
      expect(field.getStore()).toBeUndefined();
      expect(sibling.getStore()).toBe("survives return");
      expect(() =>
        field.run("outer", () =>
          field.exit(() => {
            sibling.enterWith("survives throw");
            throw new Error("callback failed");
          }),
        ),
      ).toThrow("callback failed");
      expect(field.getStore()).toBeUndefined();
      expect(sibling.getStore()).toBe("survives throw");
    });
    root.emitDestroy();
    native.run("caller", () => {
      const resource = executionAsyncId();
      field.run("native-boundary", () => {
        expect(executionAsyncId()).toBe(resource);
        native.enterWith("visible after native run");
      });
      expect(native.getStore()).toBe("visible after native run");
      runWithAsyncStore(field, "isolated-boundary", () => {
        native.enterWith("isolated");
        expect(field.getStore()).toBe("isolated-boundary");
      });
      expect(native.getStore()).toBe("visible after native run");
      expect(field.getStore()).toBeUndefined();
    });
  });

  it("shares explicitly global fields and keeps local fields independent", () => {
    const key = Symbol.for("openclaw.test.asyncContext");
    const first = new AsyncContext<number>(key);
    const second = new AsyncContext<number>(key);
    const local = new AsyncContext<number>(Symbol("openclaw.test.asyncContext"));
    first.run(Number.NaN, () => {
      expect(second.getStore()).toBeNaN();
      expect(local.getStore()).toBeUndefined();
      second.run(-0, () => expect(Object.is(first.getStore(), -0)).toBe(true));
      expect(first.getStore()).toBeNaN();
    });
  });
});

import assert from "node:assert/strict";
import { describe, expect, it, vi } from "vitest";
import {
  materializeErrorStack,
  throwIfSettledRejected,
  throwSettledAggregate,
} from "./error-graph-internal.js";

it("formats aggregate siblings through immutable cyclic parents without replacing errors", () => {
  const child = new TypeError("child failure");
  const format = vi.fn(() => "child stack");
  Object.defineProperty(child, "stack", {
    get: format,
    set() {},
  });
  const parent = new AggregateError([child], "aggregate failure");
  parent.cause = parent;
  Object.defineProperty(parent, "stack", { value: "fixed", writable: false });
  materializeErrorStack(parent);
  expect(format).toHaveBeenCalledOnce();
});

it("does not replace failures when diagnostic properties cannot be read or written", () => {
  const opaque = new Error("opaque");
  const unavailable = () => {
    throw new Error("unavailable");
  };
  Object.defineProperties(opaque, { stack: { get: unavailable }, cause: { get: unavailable } });
  expect(() => materializeErrorStack(opaque)).not.toThrow();
});

describe.each([throwIfSettledRejected, throwSettledAggregate])("%s", (settle) => {
  it("accepts empty and successful work", () => {
    settle([], "cleanup failed");
    settle([{ status: "fulfilled", value: undefined }], "cleanup failed");
  });
  it.each([new Error("first"), "failure", undefined])(
    "preserves sole rejection identity: %s",
    (reason) => {
      let caught = false;
      try {
        settle([{ status: "rejected", reason }], "cleanup failed");
      } catch (error) {
        caught = true;
        if (settle === throwIfSettledRejected) {
          expect(error).toBe(reason);
        } else {
          assert(error instanceof AggregateError);
          expect(error.message).toBe("cleanup failed");
          expect(error.errors).toEqual([reason]);
          expect(error.errors[0]).toBe(reason);
          expect(Object.hasOwn(error, "cause")).toBe(false);
        }
      }
      expect(caught).toBe(true);
    },
  );
  it("aggregates independent failures in order among successes", () => {
    const first = new Error("first");
    try {
      settle(
        [
          { status: "rejected", reason: first },
          { status: "fulfilled", value: "ok" },
          { status: "rejected", reason: "second" },
        ],
        "joined cleanup failed",
      );
      expect.unreachable("must reject");
    } catch (error) {
      assert(error instanceof AggregateError);
      expect(error.message).toBe("joined cleanup failed");
      expect(error.errors).toEqual([first, "second"]);
      expect(error.errors[0]).toBe(first);
    }
  });
});

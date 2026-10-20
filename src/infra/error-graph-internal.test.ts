import { describe, expect, it } from "vitest";
import { throwIfSettledRejected, throwSettledAggregate } from "./error-graph-internal.js";

describe("throwIfSettledRejected", () => {
  it("accepts empty or successful work", () => {
    expect(() => throwIfSettledRejected([], "cleanup failed")).not.toThrow();
    expect(() =>
      throwIfSettledRejected([{ status: "fulfilled", value: undefined }], "cleanup failed"),
    ).not.toThrow();
  });

  it.each([new Error("cleanup failed"), "failure", undefined])(
    "preserves a single rejection reason: %s",
    (reason) => {
      let caught = false;
      try {
        throwIfSettledRejected([{ status: "rejected", reason }], "cleanup failed");
      } catch (error) {
        caught = true;
        expect(error).toBe(reason);
      }
      expect(caught).toBe(true);
    },
  );

  it("aggregates failures in input order with the caller's message", () => {
    const first = new Error("first");
    try {
      throwIfSettledRejected(
        [
          { status: "rejected", reason: first },
          { status: "fulfilled", value: "success" },
          { status: "rejected", reason: "second" },
        ],
        "Some cleanup failed",
      );
      expect.unreachable("multiple failures must be reported");
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError);
      if (!(error instanceof AggregateError)) {
        throw error;
      }
      expect(error.message).toBe("Some cleanup failed");
      expect(error.errors).toEqual([first, "second"]);
      expect(error.errors[0]).toBe(first);
    }
  });
});

describe("throwSettledAggregate", () => {
  it("accepts empty or successful work", () => {
    expect(() => throwSettledAggregate([], "cleanup failed")).not.toThrow();
    expect(() =>
      throwSettledAggregate([{ status: "fulfilled", value: undefined }], "cleanup failed"),
    ).not.toThrow();
  });

  it("retains an aggregate envelope for a single non-Error rejection", () => {
    try {
      throwSettledAggregate([{ status: "rejected", reason: undefined }], "cleanup failed");
      expect.unreachable("the sole failure must be reported");
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError);
      if (!(error instanceof AggregateError)) {
        throw error;
      }
      expect(error.message).toBe("cleanup failed");
      expect(error.errors).toEqual([undefined]);
      expect(Object.hasOwn(error, "cause")).toBe(false);
    }
  });

  it("preserves rejection identities and input order among successful work", () => {
    const first = new Error("first");
    try {
      throwSettledAggregate(
        [
          { status: "fulfilled", value: "success" },
          { status: "rejected", reason: first },
          { status: "rejected", reason: "second" },
        ],
        "joined cleanup failed",
      );
      expect.unreachable("the joined failures must be reported");
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError);
      if (!(error instanceof AggregateError)) {
        throw error;
      }
      expect(error.message).toBe("joined cleanup failed");
      expect(error.errors).toEqual([first, "second"]);
      expect(error.errors[0]).toBe(first);
    }
  });
});

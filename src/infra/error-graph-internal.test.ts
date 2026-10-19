import { describe, expect, it } from "vitest";
import { throwIfSettledRejected } from "./error-graph-internal.js";

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

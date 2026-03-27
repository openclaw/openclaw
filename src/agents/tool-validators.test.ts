import { describe, expect, it } from "vitest";
import { evaluateToolValidators, __testing } from "./tool-validators.js";

const { evaluateSimplePredicate, getNestedValue } = __testing;

describe("evaluateSimplePredicate", () => {
  it("$ > N", () => {
    expect(evaluateSimplePredicate("$ > 0", 5)).toBe(true);
    expect(evaluateSimplePredicate("$ > 0", 0)).toBe(false);
    expect(evaluateSimplePredicate("$ > 0", -1)).toBe(false);
  });

  it("$ < N", () => {
    expect(evaluateSimplePredicate("$ < 100", 50)).toBe(true);
    expect(evaluateSimplePredicate("$ < 100", 100)).toBe(false);
  });

  it("$ >= N and $ <= N", () => {
    expect(evaluateSimplePredicate("$ >= 1", 1)).toBe(true);
    expect(evaluateSimplePredicate("$ <= 99999", 99999)).toBe(true);
    expect(evaluateSimplePredicate("$ <= 99999", 100000)).toBe(false);
  });

  it("$ === V", () => {
    expect(evaluateSimplePredicate('$ === "active"', "active")).toBe(true);
    expect(evaluateSimplePredicate('$ === "active"', "inactive")).toBe(false);
    expect(evaluateSimplePredicate("$ === true", true)).toBe(true);
  });

  it("$ !== V", () => {
    expect(evaluateSimplePredicate('$ !== ""', "hello")).toBe(true);
    expect(evaluateSimplePredicate('$ !== ""', "")).toBe(false);
  });

  it("$.length comparisons", () => {
    expect(evaluateSimplePredicate("$.length > 0", [1, 2, 3])).toBe(true);
    expect(evaluateSimplePredicate("$.length > 0", [])).toBe(false);
    expect(evaluateSimplePredicate("$.length < 100", "hello")).toBe(true);
  });

  it("&& combinator (all must pass)", () => {
    expect(evaluateSimplePredicate("$ > 0 && $ < 100000", 500)).toBe(true);
    expect(evaluateSimplePredicate("$ > 0 && $ < 100000", -1)).toBe(false);
    expect(evaluateSimplePredicate("$ > 0 && $ < 100000", 100001)).toBe(false);
  });

  it("|| combinator (any must pass)", () => {
    expect(evaluateSimplePredicate('$ === "done" || $ === "completed"', "done")).toBe(true);
    expect(evaluateSimplePredicate('$ === "done" || $ === "completed"', "completed")).toBe(true);
    expect(evaluateSimplePredicate('$ === "done" || $ === "completed"', "pending")).toBe(false);
  });
});

describe("getNestedValue", () => {
  it("gets top-level field", () => {
    expect(getNestedValue({ quantity: 5 }, "quantity")).toBe(5);
  });

  it("gets nested field", () => {
    expect(getNestedValue({ order: { id: "abc" } }, "order.id")).toBe("abc");
  });

  it("returns undefined for missing path", () => {
    expect(getNestedValue({ a: 1 }, "b")).toBeUndefined();
  });
});

describe("evaluateToolValidators", () => {
  it("passes when no validators match the tool", () => {
    const result = evaluateToolValidators("some_tool", { quantity: 5 }, [
      { tool: "other_tool", field: "quantity", assert: "$ > 10" },
    ]);
    expect(result).toBeNull();
  });

  it("passes when all assertions pass", () => {
    const result = evaluateToolValidators("record_inbound", { quantity: 50 }, [
      { tool: "record_inbound", field: "quantity", assert: "$ > 0 && $ < 100000" },
    ]);
    expect(result).toBeNull();
  });

  it("blocks when assertion fails", () => {
    const result = evaluateToolValidators("record_inbound", { quantity: -5 }, [
      {
        tool: "record_inbound",
        field: "quantity",
        assert: "$ > 0 && $ < 100000",
        message: "Quantity must be positive",
      },
    ]);
    expect(result).toBe("Quantity must be positive");
  });

  it("uses default message when custom message not provided", () => {
    const result = evaluateToolValidators("record_inbound", { quantity: -5 }, [
      { tool: "record_inbound", field: "quantity", assert: "$ > 0" },
    ]);
    expect(result).toContain("Validation failed");
    expect(result).toContain("record_inbound");
    expect(result).toContain("quantity");
  });

  it("skips validation when field is missing from params", () => {
    const result = evaluateToolValidators("record_inbound", { sku: "ABC" }, [
      { tool: "record_inbound", field: "quantity", assert: "$ > 0" },
    ]);
    expect(result).toBeNull();
  });

  it("validates array length", () => {
    const result = evaluateToolValidators("record_order", { items: [] }, [
      { tool: "record_order", field: "items", assert: "$.length > 0", message: "Must have items" },
    ]);
    expect(result).toBe("Must have items");
  });

  it("evaluates multiple validators for the same tool", () => {
    const validators = [
      { tool: "record_inbound", field: "quantity", assert: "$ > 0", message: "Qty positive" },
      { tool: "record_inbound", field: "quantity", assert: "$ < 100000", message: "Qty too large" },
    ];

    expect(evaluateToolValidators("record_inbound", { quantity: 50 }, validators)).toBeNull();
    expect(evaluateToolValidators("record_inbound", { quantity: -1 }, validators)).toBe(
      "Qty positive",
    );
    expect(evaluateToolValidators("record_inbound", { quantity: 200000 }, validators)).toBe(
      "Qty too large",
    );
  });
});

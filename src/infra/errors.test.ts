import { describe, expect, it } from "vitest";
import { isTransientGatewayError } from "./errors.js";

describe("isTransientGatewayError", () => {
  it("returns true for zombie connection error", () => {
    const err = new Error(
      "Attempted to reconnect zombie connection after disconnecting first (this shouldn't be possible)",
    );
    expect(isTransientGatewayError(err)).toBe(true);
  });

  it("returns true for gateway reconnect-after-disconnect error", () => {
    const err = new Error(
      "Attempted to reconnect gateway after disconnecting first (this shouldn't be possible)",
    );
    expect(isTransientGatewayError(err)).toBe(true);
  });

  it("returns false for unrelated errors", () => {
    expect(isTransientGatewayError(new Error("something else"))).toBe(false);
    expect(isTransientGatewayError(new Error("Max reconnect attempts"))).toBe(false);
    expect(isTransientGatewayError(new Error("Fatal Gateway error"))).toBe(false);
  });

  it("returns false for non-Error values", () => {
    expect(isTransientGatewayError("zombie")).toBe(false);
    expect(isTransientGatewayError(null)).toBe(false);
    expect(isTransientGatewayError(undefined)).toBe(false);
    expect(isTransientGatewayError(42)).toBe(false);
  });
});

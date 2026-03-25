import { describe, expect, it } from "vitest";
import { GatewayRequestError } from "../gateway.ts";
import {
  formatMissingOperatorReadScopeMessage,
  isMissingOperatorReadScopeError,
} from "./scope-errors.ts";

describe("isMissingOperatorReadScopeError", () => {
  it("detects structured AUTH_UNAUTHORIZED scope failures", () => {
    const err = new GatewayRequestError({
      code: "PERMISSION_DENIED",
      message: "not allowed",
      details: { code: "AUTH_UNAUTHORIZED" },
    });

    expect(isMissingOperatorReadScopeError(err)).toBe(true);
  });

  it("falls back to the gateway message when no detail code is present", () => {
    const err = new GatewayRequestError({
      code: "PERMISSION_DENIED",
      message: "missing scope: operator.read",
    });

    expect(isMissingOperatorReadScopeError(err)).toBe(true);
  });

  it("ignores unrelated gateway errors", () => {
    const err = new GatewayRequestError({
      code: "PERMISSION_DENIED",
      message: "not allowed",
      details: { code: "PAIRING_REQUIRED" },
    });

    expect(isMissingOperatorReadScopeError(err)).toBe(false);
  });
});

describe("formatMissingOperatorReadScopeMessage", () => {
  it("formats a targeted operator scope error", () => {
    expect(formatMissingOperatorReadScopeMessage("usage")).toBe(
      "This connection is missing operator.read, so usage cannot be loaded yet.",
    );
  });
});

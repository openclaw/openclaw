/**
 * Unauthorized-role flood guard tests for logging and socket close decisions.
 */
import { describe, expect, it } from "vitest";
import { ErrorCodes, errorShape } from "../../../../packages/gateway-protocol/src/index.js";
import { isUnauthorizedRoleError, UnauthorizedFloodGuard } from "./unauthorized-flood-guard.js";

describe("UnauthorizedFloodGuard", () => {
  it("suppresses repeated unauthorized responses and closes after threshold", () => {
    const guard = new UnauthorizedFloodGuard();

    const first = guard.registerUnauthorized();
    expect(first).toEqual({
      shouldClose: false,
      shouldLog: true,
      count: 1,
      suppressedSinceLastLog: 0,
    });

    for (let count = 2; count <= 10; count += 1) {
      expect(guard.registerUnauthorized()).toEqual({
        shouldClose: false,
        shouldLog: false,
        count,
        suppressedSinceLastLog: 0,
      });
    }

    const eleventh = guard.registerUnauthorized();
    expect(eleventh).toEqual({
      shouldClose: true,
      shouldLog: true,
      count: 11,
      suppressedSinceLastLog: 9,
    });
    expect(guard.registerUnauthorized()).toEqual({
      shouldClose: true,
      shouldLog: true,
      count: 12,
      suppressedSinceLastLog: 0,
    });
  });

  it("resets counters", () => {
    const guard = new UnauthorizedFloodGuard();
    guard.registerUnauthorized();
    guard.registerUnauthorized();
    guard.reset();

    const next = guard.registerUnauthorized();
    expect(next).toEqual({
      shouldClose: false,
      shouldLog: true,
      count: 1,
      suppressedSinceLastLog: 0,
    });
  });
});

describe("isUnauthorizedRoleError", () => {
  it("detects unauthorized role responses", () => {
    expect(
      isUnauthorizedRoleError(errorShape(ErrorCodes.INVALID_REQUEST, "unauthorized role: node")),
    ).toBe(true);
  });

  it("ignores non-role authorization errors", () => {
    expect(
      isUnauthorizedRoleError(
        errorShape(ErrorCodes.INVALID_REQUEST, "missing scope: operator.admin"),
      ),
    ).toBe(false);
    expect(isUnauthorizedRoleError(errorShape(ErrorCodes.UNAVAILABLE, "service unavailable"))).toBe(
      false,
    );
  });
});

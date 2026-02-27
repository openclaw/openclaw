import { describe, expect, it } from "vitest";
import { ErrorCodes, errorShape } from "../../protocol/index.js";
import { isUnauthorizedRoleError, UnauthorizedFloodGuard } from "./unauthorized-flood-guard.js";

describe("UnauthorizedFloodGuard", () => {
  it("suppresses repeated unauthorized responses and closes after threshold", () => {
    const guard = new UnauthorizedFloodGuard({ closeAfter: 2, logEvery: 3 });

    const first = guard.registerUnauthorized();
    expect(first).toEqual({
      shouldClose: false,
      shouldLog: true,
      count: 1,
      suppressedSinceLastLog: 0,
    });

    const second = guard.registerUnauthorized();
    expect(second).toEqual({
      shouldClose: false,
      shouldLog: false,
      count: 2,
      suppressedSinceLastLog: 0,
    });

    const third = guard.registerUnauthorized();
    expect(third).toEqual({
      shouldClose: true,
      shouldLog: true,
      count: 3,
      suppressedSinceLastLog: 1,
    });
  });

  it("resets counters", () => {
    const guard = new UnauthorizedFloodGuard({ closeAfter: 10, logEvery: 50 });
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

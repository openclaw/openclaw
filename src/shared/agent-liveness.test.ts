import { describe, expect, it } from "vitest";
import {
  formatAbandonedLivenessError,
  formatBlockedLivenessError,
  isAbandonedLivenessState,
  isBlockedLivenessState,
  normalizeBlockedLivenessWaitStatus,
} from "./agent-liveness.js";

describe("isBlockedLivenessState", () => {
  it('returns true for "blocked"', () => {
    expect(isBlockedLivenessState("blocked")).toBe(true);
  });

  it('returns true for "BLOCKED" (case-insensitive)', () => {
    expect(isBlockedLivenessState("BLOCKED")).toBe(true);
  });

  it("returns true with surrounding whitespace", () => {
    expect(isBlockedLivenessState("  blocked  ")).toBe(true);
  });

  it("returns false for non-string values", () => {
    expect(isBlockedLivenessState(null)).toBe(false);
    expect(isBlockedLivenessState(undefined)).toBe(false);
    expect(isBlockedLivenessState(42)).toBe(false);
  });

  it("returns false for other states", () => {
    expect(isBlockedLivenessState("ok")).toBe(false);
    expect(isBlockedLivenessState("abandoned")).toBe(false);
  });
});

describe("isAbandonedLivenessState", () => {
  it('returns true for "abandoned"', () => {
    expect(isAbandonedLivenessState("abandoned")).toBe(true);
  });

  it("returns false for non-string values", () => {
    expect(isAbandonedLivenessState(null)).toBe(false);
    expect(isAbandonedLivenessState(undefined)).toBe(false);
  });
});

describe("formatBlockedLivenessError", () => {
  it("returns the trimmed error string", () => {
    expect(formatBlockedLivenessError("  timeout  ")).toBe("timeout");
  });

  it("returns a default message when error is not a string", () => {
    expect(formatBlockedLivenessError(null)).toBe(
      "Agent run blocked before producing a usable result.",
    );
    expect(formatBlockedLivenessError(42)).toBe(
      "Agent run blocked before producing a usable result.",
    );
  });
});

describe("formatAbandonedLivenessError", () => {
  it("returns the trimmed error string", () => {
    expect(formatAbandonedLivenessError("  cancelled  ")).toBe("cancelled");
  });

  it("returns a default message when error is not a string", () => {
    expect(formatAbandonedLivenessError(undefined)).toBe(
      "Agent run ended before producing a complete result.",
    );
  });
});

describe("normalizeBlockedLivenessWaitStatus", () => {
  it("returns original status when livenessState is not blocked", () => {
    const result = normalizeBlockedLivenessWaitStatus({
      status: "ok",
      livenessState: "running",
    });
    expect(result.status).toBe("ok");
    expect(result.error).toBeUndefined();
  });

  it("coerces status to error when livenessState is blocked", () => {
    const result = normalizeBlockedLivenessWaitStatus({
      status: "ok",
      livenessState: "blocked",
    });
    expect(result.status).toBe("error");
    expect(result.error).toBe("Agent run blocked before producing a usable result.");
  });

  it("preserves error when status is already error", () => {
    const result = normalizeBlockedLivenessWaitStatus({
      status: "error",
      error: "custom error",
    });
    expect(result.status).toBe("error");
    expect(result.error).toBe("custom error");
  });

  it("passes error through when livenessState is blocked", () => {
    const result = normalizeBlockedLivenessWaitStatus({
      status: "ok",
      livenessState: "blocked",
      error: "specific reason",
    });
    expect(result.status).toBe("error");
    expect(result.error).toBe("specific reason");
  });
});

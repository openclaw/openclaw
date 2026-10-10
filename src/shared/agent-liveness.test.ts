// Agent liveness tests cover blocked-run state detection and error formatting.
import { describe, expect, it } from "vitest";
import {
  formatBlockedLivenessError,
  normalizeBlockedLivenessWaitStatus,
} from "./agent-liveness.js";

describe("formatBlockedLivenessError", () => {
  it("returns a default message for empty or non-string values", () => {
    expect(formatBlockedLivenessError("")).toBe(
      "Agent run blocked before producing a usable result.",
    );
    expect(formatBlockedLivenessError(undefined)).toBe(
      "Agent run blocked before producing a usable result.",
    );
    expect(formatBlockedLivenessError(null)).toBe(
      "Agent run blocked before producing a usable result.",
    );
    expect(formatBlockedLivenessError(123)).toBe(
      "Agent run blocked before producing a usable result.",
    );
  });
});

describe("normalizeBlockedLivenessWaitStatus", () => {
  it("converts status to error when liveness state is blocked", () => {
    expect(
      normalizeBlockedLivenessWaitStatus({
        status: "ok",
        livenessState: " Blocked ",
      }),
    ).toEqual({
      status: "error",
      error: "Agent run blocked before producing a usable result.",
    });
  });

  it("preserves the original status when liveness is not blocked", () => {
    expect(
      normalizeBlockedLivenessWaitStatus({
        status: "ok",
        livenessState: undefined,
      }),
    ).toEqual({ status: "ok" });
    expect(
      normalizeBlockedLivenessWaitStatus({
        status: "timeout",
        livenessState: "running",
      }),
    ).toEqual({ status: "timeout" });
  });

  it("passes through error string when liveness is not blocked", () => {
    expect(
      normalizeBlockedLivenessWaitStatus({
        status: "timeout",
        error: "request timed out",
      }),
    ).toEqual({ status: "timeout", error: "request timed out" });
  });

  it("uses provided error message in blocked state", () => {
    expect(
      normalizeBlockedLivenessWaitStatus({
        status: "pending",
        livenessState: "blocked",
        error: "  gateway unavailable ",
      }),
    ).toEqual({ status: "error", error: "gateway unavailable" });
  });
});

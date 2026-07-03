// Tests for agent liveness state helpers.
import { describe, expect, it } from "vitest";
import {
  isBlockedLivenessState,
  formatBlockedLivenessError,
  normalizeBlockedLivenessWaitStatus,
} from "./agent-liveness.js";

describe("isBlockedLivenessState", () => {
  it("returns true for blocked string", () => {
    expect(isBlockedLivenessState("blocked")).toBe(true);
  });
  it("returns true for BLOCKED case insensitive", () => {
    expect(isBlockedLivenessState("BLOCKED")).toBe(true);
  });
  it("returns true for blocked with whitespace", () => {
    expect(isBlockedLivenessState("  blocked  ")).toBe(true);
  });
  it("returns false for other string", () => {
    expect(isBlockedLivenessState("running")).toBe(false);
  });
  it("returns false for non-string", () => {
    expect(isBlockedLivenessState(123)).toBe(false);
  });
});

describe("formatBlockedLivenessError", () => {
  it("returns trimmed string error", () => {
    expect(formatBlockedLivenessError("  timeout  ")).toBe("timeout");
  });
  it("returns default message for non-string", () => {
    expect(formatBlockedLivenessError(123)).toBe(
      "Agent run blocked before producing a usable result.",
    );
  });
  it("returns default message for empty string", () => {
    expect(formatBlockedLivenessError("")).toBe(
      "Agent run blocked before producing a usable result.",
    );
  });
});

describe("normalizeBlockedLivenessWaitStatus", () => {
  it("returns original status when not blocked", () => {
    expect(normalizeBlockedLivenessWaitStatus({ status: "ok", livenessState: "running" })).toEqual({
      status: "ok",
      error: undefined,
    });
  });
  it("returns error status when blocked", () => {
    expect(normalizeBlockedLivenessWaitStatus({ status: "ok", livenessState: "blocked" })).toEqual({
      status: "error",
      error: "Agent run blocked before producing a usable result.",
    });
  });
  it("preserves existing error string", () => {
    expect(
      normalizeBlockedLivenessWaitStatus({
        status: "ok",
        livenessState: "blocked",
        error: "custom error",
      }),
    ).toEqual({ status: "error", error: "custom error" });
  });
});

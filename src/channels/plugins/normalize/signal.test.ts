import { describe, expect, it } from "vitest";
import { looksLikeSignalTargetId, normalizeSignalMessagingTarget } from "./signal.js";

describe("signal target normalization", () => {
  it("normalizes uuid targets by stripping uuid:", () => {
    expect(normalizeSignalMessagingTarget("uuid:123E4567-E89B-12D3-A456-426614174000")).toBe(
      "123e4567-e89b-12d3-a456-426614174000",
    );
  });

  it("normalizes signal:uuid targets", () => {
    expect(normalizeSignalMessagingTarget("signal:uuid:123E4567-E89B-12D3-A456-426614174000")).toBe(
      "123e4567-e89b-12d3-a456-426614174000",
    );
  });

  it("accepts uuid prefixes for target detection", () => {
    expect(looksLikeSignalTargetId("uuid:123e4567-e89b-12d3-a456-426614174000")).toBe(true);
    expect(looksLikeSignalTargetId("signal:uuid:123e4567-e89b-12d3-a456-426614174000")).toBe(true);
  });

  it("accepts compact UUIDs for target detection", () => {
    expect(looksLikeSignalTargetId("123e4567e89b12d3a456426614174000")).toBe(true);
    expect(looksLikeSignalTargetId("uuid:123e4567e89b12d3a456426614174000")).toBe(true);
  });

  it("rejects invalid uuid prefixes", () => {
    expect(looksLikeSignalTargetId("uuid:")).toBe(false);
    expect(looksLikeSignalTargetId("uuid:not-a-uuid")).toBe(false);
  });

  it("preserves group ID case for Base64-encoded IDs", () => {
    // Base64 is case-sensitive, so group IDs must preserve their original case
    expect(
      normalizeSignalMessagingTarget("group:VpVD1Z7py+k6DSC+oxEcDey5sndViJyJ9Ogi0kvgiLY="),
    ).toBe("group:VpVD1Z7py+k6DSC+oxEcDey5sndViJyJ9Ogi0kvgiLY=");
  });

  it("preserves group ID case with signal: prefix", () => {
    expect(
      normalizeSignalMessagingTarget("signal:group:VpVD1Z7py+k6DSC+oxEcDey5sndViJyJ9Ogi0kvgiLY="),
    ).toBe("group:VpVD1Z7py+k6DSC+oxEcDey5sndViJyJ9Ogi0kvgiLY=");
  });

  it("handles mixed-case group IDs correctly", () => {
    expect(normalizeSignalMessagingTarget("GROUP:AbCdEfGhIjKlMnOp=")).toBe(
      "group:AbCdEfGhIjKlMnOp=",
    );
  });

  it("accepts group targets for target detection", () => {
    expect(looksLikeSignalTargetId("group:VpVD1Z7py+k6DSC+oxEcDey5sndViJyJ9Ogi0kvgiLY=")).toBe(
      true,
    );
    expect(
      looksLikeSignalTargetId("signal:group:VpVD1Z7py+k6DSC+oxEcDey5sndViJyJ9Ogi0kvgiLY="),
    ).toBe(true);
  });
});

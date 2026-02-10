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

  it("preserves case-sensitive Base64 group IDs", () => {
    expect(
      normalizeSignalMessagingTarget("group:p5dJRYq+l7dszyNRxJgVJsr78x5ggcBhXPla1ot1UK0="),
    ).toBe("group:p5dJRYq+l7dszyNRxJgVJsr78x5ggcBhXPla1ot1UK0=");
  });

  it("preserves case-sensitive Base64 group IDs with signal: prefix", () => {
    expect(
      normalizeSignalMessagingTarget("signal:group:p5dJRYq+l7dszyNRxJgVJsr78x5ggcBhXPla1ot1UK0="),
    ).toBe("group:p5dJRYq+l7dszyNRxJgVJsr78x5ggcBhXPla1ot1UK0=");
  });

  it("still lowercases phone numbers and usernames", () => {
    expect(normalizeSignalMessagingTarget("+14155551234")).toBe("+14155551234");
    expect(normalizeSignalMessagingTarget("username:FooBar")).toBe("username:foobar");
  });
});

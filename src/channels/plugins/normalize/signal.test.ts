import { describe, expect, it } from "vitest";
import { looksLikeSignalTargetId, normalizeSignalMessagingTarget } from "./signal.js";

describe("signal target normalization", () => {
  describe("group targets", () => {
    it("preserves case for base64-encoded group IDs", () => {
      // Signal group IDs are base64-encoded and case-sensitive
      expect(
        normalizeSignalMessagingTarget("group:igVOP2EJR1sBXYYwsLhif/AEMTJWtiDiTyu88GWP5ZQ="),
      ).toBe("group:igVOP2EJR1sBXYYwsLhif/AEMTJWtiDiTyu88GWP5ZQ=");
    });

    it("handles signal: prefix with group targets", () => {
      expect(
        normalizeSignalMessagingTarget("signal:group:igVOP2EJR1sBXYYwsLhif/AEMTJWtiDiTyu88GWP5ZQ="),
      ).toBe("group:igVOP2EJR1sBXYYwsLhif/AEMTJWtiDiTyu88GWP5ZQ=");
    });

    it("accepts group: prefix for target detection", () => {
      expect(looksLikeSignalTargetId("group:igVOP2EJR1sBXYYwsLhif/AEMTJWtiDiTyu88GWP5ZQ=")).toBe(
        true,
      );
      expect(looksLikeSignalTargetId("signal:group:someGroupId")).toBe(true);
    });
  });

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

  it("preserves group ID case (base64 is case-sensitive)", () => {
    // Base64 group IDs contain mixed case that must be preserved
    expect(
      normalizeSignalMessagingTarget("group:igVOP2EJR1sBXYYwsLhif/AEMTJWtiDiTyu88GWP5ZQ="),
    ).toBe("group:igVOP2EJR1sBXYYwsLhif/AEMTJWtiDiTyu88GWP5ZQ=");
    expect(normalizeSignalMessagingTarget("signal:group:ABC123xyz+/=")).toBe("group:ABC123xyz+/=");
  });

  it("normalizes group prefix case but preserves ID", () => {
    expect(normalizeSignalMessagingTarget("GROUP:TestGroupId123=")).toBe("group:TestGroupId123=");
    expect(normalizeSignalMessagingTarget("Group:MixedCase/+ABC=")).toBe("group:MixedCase/+ABC=");
  });
});

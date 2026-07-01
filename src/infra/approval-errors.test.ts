// Covers approval-not-found error detection.
import { describe, expect, it } from "vitest";
import {
  isApprovalAlreadyResolvedError,
  isApprovalExpiredError,
  isApprovalNotFoundError,
} from "./approval-errors.js";

describe("isApprovalNotFoundError", () => {
  it("matches direct approval-not-found gateway codes", () => {
    const err = new Error("approval not found") as Error & { gatewayCode?: string };
    err.gatewayCode = "APPROVAL_NOT_FOUND";
    expect(isApprovalNotFoundError(err)).toBe(true);
  });

  it("matches structured invalid-request approval-not-found details", () => {
    const err = new Error("approval not found") as Error & {
      gatewayCode?: string;
      details?: { reason?: string };
    };
    err.gatewayCode = "INVALID_REQUEST";
    err.details = { reason: "APPROVAL_NOT_FOUND" };
    expect(isApprovalNotFoundError(err)).toBe(true);
  });

  it("matches legacy message-only not-found errors", () => {
    expect(isApprovalNotFoundError(new Error("unknown or expired approval id"))).toBe(true);
  });

  it("ignores unrelated errors", () => {
    expect(isApprovalNotFoundError(new Error("network timeout"))).toBe(false);
    expect(isApprovalNotFoundError("unknown or expired approval id")).toBe(false);
  });
});

describe("isApprovalExpiredError", () => {
  it("matches direct expired gateway codes", () => {
    const err = new Error("approval expired") as Error & { gatewayCode?: string };
    err.gatewayCode = "APPROVAL_EXPIRED";
    expect(isApprovalExpiredError(err)).toBe(true);
  });

  it("matches structured expired details", () => {
    const err = new Error("approval expired") as Error & { details?: { reason?: string } };
    err.details = { reason: "APPROVAL_EXPIRED" };
    expect(isApprovalExpiredError(err)).toBe(true);
  });

  it("matches message-only expired errors", () => {
    expect(isApprovalExpiredError(new Error("approval expired"))).toBe(true);
  });

  it("does not treat unknown-or-expired or resolved errors as expired", () => {
    expect(isApprovalExpiredError(new Error("unknown or expired approval id"))).toBe(false);
    expect(isApprovalExpiredError(new Error("approval already resolved"))).toBe(false);
    expect(isApprovalExpiredError("approval expired")).toBe(false);
  });
});

describe("isApprovalAlreadyResolvedError", () => {
  it("matches structured already-resolved details", () => {
    const err = new Error("approval already resolved") as Error & {
      details?: { reason?: string };
    };
    err.details = { reason: "APPROVAL_ALREADY_RESOLVED" };
    expect(isApprovalAlreadyResolvedError(err)).toBe(true);
  });

  it("matches message-only already-resolved errors", () => {
    expect(isApprovalAlreadyResolvedError(new Error("approval already resolved"))).toBe(true);
  });

  it("ignores unrelated and expired errors", () => {
    expect(isApprovalAlreadyResolvedError(new Error("approval expired"))).toBe(false);
    expect(isApprovalAlreadyResolvedError(new Error("network timeout"))).toBe(false);
    expect(isApprovalAlreadyResolvedError("approval already resolved")).toBe(false);
  });
});

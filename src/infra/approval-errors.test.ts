// Covers approval-not-found error detection.
import { describe, expect, it } from "vitest";
import {
  isApprovalAuthorityError,
  isApprovalKindMismatchError,
  isApprovalNotFoundError,
  isApprovalStaleError,
  resolveFirstApprovalKind,
} from "./approval-errors.js";

describe("isApprovalNotFoundError", () => {
  it("matches direct approval-not-found gateway codes", () => {
    const err = Object.assign(new Error("approval not found"), {
      gatewayCode: "APPROVAL_NOT_FOUND",
    });
    expect(isApprovalNotFoundError(err)).toBe(true);
  });

  it("matches structured invalid-request approval-not-found details", () => {
    const err = Object.assign(new Error("approval not found"), {
      gatewayCode: "INVALID_REQUEST",
      details: { reason: "APPROVAL_NOT_FOUND" },
    });
    expect(isApprovalNotFoundError(err)).toBe(true);
  });

  it("matches legacy message-only not-found errors", () => {
    expect(isApprovalNotFoundError(new Error("unknown or expired approval id"))).toBe(true);
    expect(isApprovalNotFoundError(new Error("approval expired or not found"))).toBe(true);
  });

  it("ignores unrelated errors", () => {
    expect(isApprovalNotFoundError(new Error("network timeout"))).toBe(false);
    expect(isApprovalNotFoundError("unknown or expired approval id")).toBe(false);
  });
});

describe("isApprovalStaleError", () => {
  it("matches structured already-resolved gateway errors", () => {
    const err = Object.assign(new Error("request rejected"), {
      gatewayCode: "INVALID_REQUEST",
      details: { reason: "APPROVAL_ALREADY_RESOLVED" },
    });
    expect(isApprovalStaleError(err)).toBe(true);
  });

  it("includes approval-not-found errors", () => {
    const err = Object.assign(new Error("approval not found"), {
      gatewayCode: "APPROVAL_NOT_FOUND",
    });
    expect(isApprovalStaleError(err)).toBe(true);
  });

  it("ignores transient errors", () => {
    expect(isApprovalStaleError(new Error("gateway unavailable"))).toBe(false);
  });
});

// A refusal is only this when both the code and the reason say so: FORBIDDEN alone is also a
// missing-scope failure, which would send the operator to an approver list for no reason.
describe("isApprovalAuthorityError", () => {
  const failure = (gatewayCode: string, reason?: string) =>
    Object.assign(new Error("refused"), {
      gatewayCode,
      ...(reason ? { details: { code: reason } } : {}),
    });

  it.each([
    ["FORBIDDEN", "APPROVAL_AUTHORITY_REQUIRED", true],
    ["FORBIDDEN", undefined, false],
    ["FORBIDDEN", "MISSING_SCOPE", false],
    ["INVALID_REQUEST", "APPROVAL_AUTHORITY_REQUIRED", false],
  ])("%s with reason %s is an authority refusal: %s", (code, reason, expected) => {
    expect(isApprovalAuthorityError(failure(code, reason))).toBe(expected);
  });
});

// Walking exec then plugin, a channel that authorizes one kind and not the other answers the
// wrong kind with a refusal, so a refusal has to keep the search going just as not-found does.
describe("isApprovalKindMismatchError", () => {
  it.each([
    [{ gatewayCode: "FORBIDDEN", details: { code: "APPROVAL_AUTHORITY_REQUIRED" } }, true],
    [{ gatewayCode: "INVALID_REQUEST", details: { reason: "APPROVAL_NOT_FOUND" } }, true],
    [{ gatewayCode: "UNAVAILABLE" }, false],
  ])("%j continues the search: %s", (fields, expected) => {
    expect(isApprovalKindMismatchError(Object.assign(new Error("x"), fields))).toBe(expected);
  });
});

// A walk across kinds must end with the answer that is true for this reviewer: a refusal from
// one kind outranks a not-found from the other, in either order.
describe("resolveFirstApprovalKind", () => {
  const refusal = Object.assign(new Error("approval decision requires a listed approver"), {
    gatewayCode: "FORBIDDEN",
    details: { code: "APPROVAL_AUTHORITY_REQUIRED" },
  });
  const notFound = Object.assign(new Error("approval not found"), {
    gatewayCode: "INVALID_REQUEST",
    details: { reason: "APPROVAL_NOT_FOUND" },
  });
  const walk = (answers: Record<string, Error | "ok">) =>
    resolveFirstApprovalKind(Object.keys(answers), async (kind) => {
      const answer = answers[kind];
      if (answer instanceof Error) {
        throw answer;
      }
      return kind;
    });

  it("returns the first kind that resolves", async () => {
    await expect(walk({ exec: refusal, plugin: "ok" })).resolves.toBe("plugin");
  });

  it.each([
    ["exec refused, plugin missing", { exec: refusal, plugin: notFound }],
    ["exec missing, plugin refused", { exec: notFound, plugin: refusal }],
  ])("rethrows the refusal when %s", async (_label, answers) => {
    await expect(walk(answers)).rejects.toBe(refusal);
  });

  it("rethrows not-found when no kind refused", async () => {
    await expect(walk({ exec: notFound, plugin: notFound })).rejects.toBe(notFound);
  });

  it("stops at a failure that is neither", async () => {
    const outage = Object.assign(new Error("gateway down"), { gatewayCode: "UNAVAILABLE" });
    await expect(walk({ exec: outage, plugin: "ok" })).rejects.toBe(outage);
  });
});

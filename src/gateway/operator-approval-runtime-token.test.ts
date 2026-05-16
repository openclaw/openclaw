import { describe, expect, it } from "vitest";
import {
  getOperatorApprovalRuntimeToken,
  isOperatorApprovalRuntimeToken,
} from "./operator-approval-runtime-token.js";

describe("operator approval runtime token", () => {
  it("accepts the exact runtime token", () => {
    const token = getOperatorApprovalRuntimeToken();

    expect(isOperatorApprovalRuntimeToken(token)).toBe(true);
    expect(isOperatorApprovalRuntimeToken(` ${token} `)).toBe(true);
  });

  it("rejects missing, truncated, and extended runtime tokens", () => {
    const token = getOperatorApprovalRuntimeToken();

    expect(isOperatorApprovalRuntimeToken(undefined)).toBe(false);
    expect(isOperatorApprovalRuntimeToken(null)).toBe(false);
    expect(isOperatorApprovalRuntimeToken("")).toBe(false);
    expect(isOperatorApprovalRuntimeToken(token.slice(0, -1))).toBe(false);
    expect(isOperatorApprovalRuntimeToken(`${token}x`)).toBe(false);
  });
});

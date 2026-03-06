import { describe, expect, it } from "vitest";
import { SignedPolicySchema } from "./policy.schema.js";

describe("SignedPolicySchema", () => {
  it("accepts a minimal policy", () => {
    const result = SignedPolicySchema.safeParse({ version: 1 });
    expect(result.success).toBe(true);
  });

  it("rejects unknown top-level fields", () => {
    const result = SignedPolicySchema.safeParse({
      version: 1,
      unknown: true,
    });
    expect(result.success).toBe(false);
  });

  it("rejects unsupported policy versions", () => {
    const result = SignedPolicySchema.safeParse({ version: 2 });
    expect(result.success).toBe(false);
  });
});

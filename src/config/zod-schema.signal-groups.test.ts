import { describe, expect, it } from "vitest";
import { SignalAccountSchema, SignalConfigSchema } from "./zod-schema.providers-core.js";

describe("Signal groups schema", () => {
  it("accepts groups with requireMention override", () => {
    const result = SignalConfigSchema.safeParse({
      groups: {
        "*": { requireMention: false },
      },
    });
    expect(result.success).toBe(true);
  });

  it("accepts groups with per-group requireMention", () => {
    const result = SignalConfigSchema.safeParse({
      groups: {
        "group-id-abc": { requireMention: false },
        "group-id-xyz": { requireMention: true },
      },
    });
    expect(result.success).toBe(true);
  });

  it("accepts groups with tools policy", () => {
    const result = SignalConfigSchema.safeParse({
      groups: {
        "group-id-abc": {
          requireMention: false,
          tools: { allow: ["exec", "read"] },
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it("accepts account-level groups config", () => {
    const result = SignalAccountSchema.safeParse({
      groups: {
        "*": { requireMention: false },
      },
    });
    expect(result.success).toBe(true);
  });

  it("accepts multi-account config with groups", () => {
    const result = SignalConfigSchema.safeParse({
      accounts: {
        main: {
          groups: {
            "*": { requireMention: false },
          },
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects unknown keys in group config (strict mode)", () => {
    const result = SignalConfigSchema.safeParse({
      groups: {
        "*": { requireMention: false, unknownKey: true },
      },
    });
    expect(result.success).toBe(false);
  });

  it("accepts empty groups object", () => {
    const result = SignalConfigSchema.safeParse({
      groups: {},
    });
    expect(result.success).toBe(true);
  });
});

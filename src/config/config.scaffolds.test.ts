import { describe, expect, it } from "vitest";
import { OpenClawSchema } from "./zod-schema.js";

describe("config scaffolds (phase 0)", () => {
  it("accepts scaffolds.reasoning.enabled + phase=0", () => {
    const res = OpenClawSchema.safeParse({
      scaffolds: {
        reasoning: {
          enabled: true,
          phase: 0,
        },
      },
    });

    expect(res.success).toBe(true);
  });

  it("rejects scaffolds.reasoning.phase != 0", () => {
    const res = OpenClawSchema.safeParse({
      scaffolds: {
        reasoning: {
          enabled: true,
          phase: 1,
        },
      },
    });

    expect(res.success).toBe(false);
  });
});

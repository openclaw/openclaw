import { describe, expect, it } from "vitest";
import { skillsLoadConfigSchema } from "./zod-schema.js";

describe("skillsLoadConfigSchema", () => {
  it("accepts index loading fields", () => {
    const result = skillsLoadConfigSchema.safeParse({
      indexFileName: "skills-index.json",
      indexFirst: true,
      strictIndex: true,
    });

    expect(result.success).toBe(true);
  });

  it("rejects unknown fields", () => {
    const result = skillsLoadConfigSchema.safeParse({
      extraDirs: [],
      bogusField: 123,
    } as never);

    expect(result.success).toBe(false);
  });
});

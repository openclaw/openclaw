import { describe, expect, it } from "vitest";
import {
  buildOptionalSecretInputSchema,
  buildSecretInputArraySchema,
  normalizeSecretInputString,
} from "./secret-input.js";

describe("plugin-sdk secret input helpers", () => {
  it("accepts undefined for optional secret input", () => {
    expect(buildOptionalSecretInputSchema().safeParse(undefined).success).toBe(true);
  });

  it("accepts arrays of secret inputs", () => {
    const result = buildSecretInputArraySchema().safeParse([
      "sk-plain",
      { source: "env", provider: "default", id: "OPENAI_API_KEY" },
    ]);
    expect(result.success).toBe(true);
  });

  it("normalizes plaintext secret strings", () => {
    expect(normalizeSecretInputString("  sk-test  ")).toBe("sk-test");
  });
});

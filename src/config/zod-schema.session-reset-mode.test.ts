import { describe, expect, it } from "vitest";
import { SessionSchema } from "./zod-schema.session.js";

describe("SessionSchema reset mode", () => {
  it("accepts off mode for manual-only session resets", () => {
    expect(() =>
      SessionSchema.parse({
        reset: {
          mode: "off",
        },
      }),
    ).not.toThrow();
  });
});

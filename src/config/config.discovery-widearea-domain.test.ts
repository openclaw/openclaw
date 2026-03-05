import { describe, expect, it } from "vitest";
import { OpenClawSchema } from "./zod-schema.js";

describe("discovery wideArea schema", () => {
  it("accepts discovery.wideArea.domain", () => {
    const res = OpenClawSchema.safeParse({
      discovery: {
        wideArea: {
          enabled: true,
          domain: "openclaw.internal",
        },
      },
    });

    expect(res.success).toBe(true);
  });
});

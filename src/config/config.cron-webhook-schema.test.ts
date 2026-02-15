import { describe, expect, it } from "vitest";
import { OpenClawSchema } from "./zod-schema.js";

describe("cron webhook schema", () => {
  it("accepts cron.webhook", () => {
    const res = OpenClawSchema.safeParse({
      cron: {
        enabled: true,
        webhook: "https://example.invalid/cron",
      },
    });

    expect(res.success).toBe(true);
  });
});

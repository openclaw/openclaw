import { describe, expect, it } from "vitest";
import { OpenClawSchema } from "./zod-schema.js";

describe("cron webhook schema", () => {
  it("accepts cron.webhook and cron.webhookToken", () => {
    const res = OpenClawSchema.safeParse({
      cron: {
        enabled: true,
        webhook: "https://example.invalid/cron",
        webhookToken: "secret-token",
      },
    });

    expect(res.success).toBe(true);
  });

  it("rejects non-http(s) cron.webhook URLs", () => {
    const res = OpenClawSchema.safeParse({
      cron: {
        webhook: "ftp://example.invalid/cron",
      },
    });

    expect(res.success).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { OpenClawSchema } from "./zod-schema.js";

describe("OpenClawSchema cron triggers", () => {
  it("accepts the strict trigger gate and interval floor", () => {
    expect(
      OpenClawSchema.parse({ cron: { triggers: { enabled: true, minIntervalMs: 45_000 } } }).cron
        ?.triggers,
    ).toEqual({ enabled: true, minIntervalMs: 45_000 });
  });

  it("rejects invalid and unknown trigger settings", () => {
    expect(OpenClawSchema.safeParse({ cron: { triggers: { minIntervalMs: 0 } } }).success).toBe(
      false,
    );
    expect(
      OpenClawSchema.safeParse({ cron: { triggers: { enabled: true, extra: true } } }).success,
    ).toBe(false);
  });
});

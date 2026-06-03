import { describe, expect, it } from "vitest";
import { OpenClawSchema } from "./zod-schema.js";

describe("OpenClawSchema cron.minInterval validation", () => {
  it("accepts duration strings and millisecond numbers", () => {
    expect(OpenClawSchema.safeParse({ cron: { minInterval: "5m" } }).success).toBe(true);
    expect(OpenClawSchema.safeParse({ cron: { minInterval: "30s" } }).success).toBe(true);
    expect(OpenClawSchema.safeParse({ cron: { minInterval: 60_000 } }).success).toBe(true);
    expect(OpenClawSchema.safeParse({ cron: { minInterval: 0 } }).success).toBe(true);
  });

  it("rejects unparseable duration strings", () => {
    expect(() => OpenClawSchema.parse({ cron: { minInterval: "soon" } })).toThrow(
      /minInterval|duration/i,
    );
  });

  it("rejects negative millisecond numbers", () => {
    expect(OpenClawSchema.safeParse({ cron: { minInterval: -1 } }).success).toBe(false);
  });
});

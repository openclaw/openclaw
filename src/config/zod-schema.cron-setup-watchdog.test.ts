import { describe, it, expect } from "vitest";
import { OpenClawSchema } from "./zod-schema.js";

describe("cron agentSetupWatchdogMs config parsing", () => {
  it("accepts a positive integer value", () => {
    const parsed = OpenClawSchema.parse({
      cron: { agentSetupWatchdogMs: 120000 },
    });
    expect(parsed.cron?.agentSetupWatchdogMs).toBe(120000);
  });

  it("parses cleanly when the key is omitted", () => {
    const parsed = OpenClawSchema.parse({
      cron: { maxConcurrentRuns: 2 },
    });
    expect(parsed.cron?.agentSetupWatchdogMs).toBeUndefined();
  });

  it("rejects non-integer values", () => {
    expect(() =>
      OpenClawSchema.parse({
        cron: { agentSetupWatchdogMs: 1500.5 },
      }),
    ).toThrow();
  });

  it("rejects non-positive values", () => {
    expect(() =>
      OpenClawSchema.parse({
        cron: { agentSetupWatchdogMs: 0 },
      }),
    ).toThrow();
  });
});

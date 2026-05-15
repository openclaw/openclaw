import { describe, expect, it } from "vitest";
import { OpenClawSchema } from "./zod-schema.js";

describe("OpenClawSchema cron retention and run-log validation", () => {
  it("accepts valid cron.sessionRetention and runLog values", () => {
    const result = OpenClawSchema.safeParse({
      cron: {
        sessionRetention: "1h30m",
        isolatedAgentSetupWatchdog: "5m",
        isolatedAgentPreExecutionWatchdog: 120_000,
        runLog: {
          maxBytes: "5mb",
          keepLines: 2500,
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid cron.sessionRetention", () => {
    expect(() =>
      OpenClawSchema.parse({
        cron: {
          sessionRetention: "abc",
        },
      }),
    ).toThrow(/sessionRetention|duration/i);
  });

  it("rejects invalid isolated agent watchdog durations", () => {
    expect(() =>
      OpenClawSchema.parse({
        cron: {
          isolatedAgentSetupWatchdog: "wat",
        },
      }),
    ).toThrow(/isolatedAgentSetupWatchdog|duration/i);
    expect(() =>
      OpenClawSchema.parse({
        cron: {
          isolatedAgentPreExecutionWatchdog: 0,
        },
      }),
    ).toThrow(/isolatedAgentPreExecutionWatchdog|duration/i);
  });

  it("rejects invalid cron.runLog.maxBytes", () => {
    expect(() =>
      OpenClawSchema.parse({
        cron: {
          runLog: {
            maxBytes: "wat",
          },
        },
      }),
    ).toThrow(/runLog|maxBytes|size/i);
  });
});

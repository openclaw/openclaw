import { describe, expect, it } from "vitest";
import { OpenClawSchema } from "./zod-schema.js";

describe("OpenClawSchema cron retention and run-log validation", () => {
  it("accepts cron agent-turn watchdog config", () => {
    expect(
      OpenClawSchema.safeParse({
        cron: {
          agentTurnWatchdog: {
            preModelTimeoutMs: 120_000,
          },
        },
      }),
    ).toMatchObject({ success: true });
  });

  it("rejects negative cron agent-turn pre-model watchdog config", () => {
    expect(() =>
      OpenClawSchema.parse({
        cron: {
          agentTurnWatchdog: {
            preModelTimeoutMs: -1,
          },
        },
      }),
    ).toThrow(/agentTurnWatchdog|preModelTimeoutMs/i);
  });

  it("accepts valid cron.sessionRetention and runLog values", () => {
    expect(
      OpenClawSchema.safeParse({
        cron: {
          sessionRetention: "1h30m",
          runLog: {
            maxBytes: "5mb",
            keepLines: 2500,
          },
        },
      }),
    ).toMatchObject({ success: true });
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

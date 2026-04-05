import { describe, expect, it } from "vitest";
import { AgentDefaultsSchema } from "./zod-schema.agent-defaults.js";
import { HeartbeatSchema } from "./zod-schema.agent-runtime.js";

describe("agent defaults schema", () => {
  it("accepts subagent archiveAfterMinutes=0 to disable archiving", () => {
    expect(() =>
      AgentDefaultsSchema.parse({
        subagents: {
          archiveAfterMinutes: 0,
        },
      }),
    ).not.toThrow();
  });
});

describe("heartbeat schedule schema", () => {
  it("accepts valid schedule array", () => {
    expect(() =>
      HeartbeatSchema.parse({
        every: "30m",
        schedule: [{ start: "08:00", end: "18:00", every: "15m" }],
      }),
    ).not.toThrow();
  });

  it("accepts empty schedule array", () => {
    expect(() =>
      HeartbeatSchema.parse({
        every: "30m",
        schedule: [],
      }),
    ).not.toThrow();
  });

  it("rejects invalid time format in schedule entry", () => {
    const result = HeartbeatSchema.safeParse({
      every: "30m",
      schedule: [{ start: "8:00", end: "18:00", every: "15m" }],
    });
    expect(result.success).toBe(false);
    expect(
      result.error!.issues.some((issue) => issue.path.includes("schedule")),
    ).toBe(true);
  });

  it("rejects invalid duration in schedule entry", () => {
    const result = HeartbeatSchema.safeParse({
      every: "30m",
      schedule: [{ start: "08:00", end: "18:00", every: "banana" }],
    });
    expect(result.success).toBe(false);
    expect(result.error!.issues.length).toBeGreaterThan(0);
  });

  it("rejects zero-width window (start equals end)", () => {
    const result = HeartbeatSchema.safeParse({
      every: "30m",
      schedule: [{ start: "08:00", end: "08:00", every: "15m" }],
    });
    expect(result.success).toBe(false);
    expect(result.error!.issues.length).toBeGreaterThan(0);
  });

  it("rejects start of 24:00", () => {
    const result = HeartbeatSchema.safeParse({
      every: "30m",
      schedule: [{ start: "24:00", end: "08:00", every: "15m" }],
    });
    expect(result.success).toBe(false);
    expect(result.error!.issues.length).toBeGreaterThan(0);
  });
});

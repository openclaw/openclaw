// Verifies cron maintenance schema parsing, defaults, and rejection cases.
import { describe, expect, it } from "vitest";
import { OpenClawSchema } from "./zod-schema.js";

const MAINTENANCE_SHAPE = {
  enabled: true,
  window: { start: "02:00", end: "04:00", timezone: "UTC" },
  maintenanceAgents: ["ops"],
  allowManualRun: false,
} as const;

describe("OpenClawSchema cron maintenance validation", () => {
  it("accepts a fully populated maintenance block", () => {
    const result = OpenClawSchema.safeParse({ cron: { maintenance: MAINTENANCE_SHAPE } });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.cron?.maintenance).toEqual(MAINTENANCE_SHAPE);
    }
  });

  it("accepts maintenance as omitted (additive, backward compatible)", () => {
    const result = OpenClawSchema.safeParse({ cron: { enabled: true } });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.cron?.maintenance).toBeUndefined();
    }
  });

  it("accepts maintenance with only enabled: false (no other fields required)", () => {
    const result = OpenClawSchema.safeParse({
      cron: { maintenance: { enabled: false } },
    });
    expect(result.success).toBe(true);
  });

  it("rejects malformed HH:MM start", () => {
    expect(() =>
      OpenClawSchema.parse({
        cron: {
          maintenance: {
            enabled: true,
            window: { start: "2am", end: "04:00" },
          },
        },
      }),
    ).toThrow(/start|HH:MM/i);
  });

  it("rejects malformed HH:MM end", () => {
    expect(() =>
      OpenClawSchema.parse({
        cron: {
          maintenance: {
            enabled: true,
            window: { start: "02:00", end: "25:00" },
          },
        },
      }),
    ).toThrow(/end|HH:MM/i);
  });

  it("rejects window with only start set", () => {
    expect(() =>
      OpenClawSchema.parse({
        cron: {
          maintenance: {
            enabled: true,
            window: { start: "02:00" },
          },
        },
      }),
    ).toThrow(/window/i);
  });

  it("rejects window with only end set", () => {
    expect(() =>
      OpenClawSchema.parse({
        cron: {
          maintenance: {
            enabled: true,
            window: { end: "04:00" },
          },
        },
      }),
    ).toThrow(/window/i);
  });

  it("rejects cross-midnight window (start > end)", () => {
    expect(() =>
      OpenClawSchema.parse({
        cron: {
          maintenance: {
            enabled: true,
            window: { start: "22:00", end: "06:00" },
          },
        },
      }),
    ).toThrow(/cross-midnight|before end/i);
  });

  it("rejects window where start equals end", () => {
    expect(() =>
      OpenClawSchema.parse({
        cron: {
          maintenance: {
            enabled: true,
            window: { start: "02:00", end: "02:00" },
          },
        },
      }),
    ).toThrow(/before end/i);
  });

  it("rejects unknown maintenance fields (strictObject)", () => {
    expect(
      OpenClawSchema.safeParse({
        cron: {
          maintenance: {
            enabled: true,
            allowManualRun: true,
            unknownField: "nope",
          },
        },
      }).success,
    ).toBe(false);
  });

  it("accepts empty maintenanceAgents array (means all deferred)", () => {
    const result = OpenClawSchema.safeParse({
      cron: {
        maintenance: {
          enabled: true,
          window: { start: "02:00", end: "04:00" },
          maintenanceAgents: [],
        },
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.cron?.maintenance?.maintenanceAgents).toEqual([]);
    }
  });

  it("accepts allowManualRun: true (opt-in operator bypass)", () => {
    const result = OpenClawSchema.safeParse({
      cron: {
        maintenance: {
          enabled: true,
          window: { start: "02:00", end: "04:00" },
          allowManualRun: true,
        },
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.cron?.maintenance?.allowManualRun).toBe(true);
    }
  });
});

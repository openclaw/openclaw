import { describe, expect, it } from "vitest";
import { OpenClawSchema } from "./zod-schema.js";

describe("OpenClawSchema cron maintenance window validation", () => {
  it("accepts a valid daily maintenance window and allowlist", () => {
    expect(() =>
      OpenClawSchema.parse({
        cron: {
          maintenance: {
            enabled: true,
            window: {
              start: "23:00",
              end: "02:00",
              timezone: "Asia/Shanghai",
            },
            maintenanceAgents: ["maint", "ops-maint"],
          },
        },
      }),
    ).not.toThrow();
  });

  it("accepts timezone aliases user/local", () => {
    expect(() =>
      OpenClawSchema.parse({
        cron: {
          maintenance: {
            enabled: true,
            window: {
              start: "01:00",
              end: "03:00",
              timezone: "user",
            },
            maintenanceAgents: ["maint"],
          },
        },
      }),
    ).not.toThrow();

    expect(() =>
      OpenClawSchema.parse({
        cron: {
          maintenance: {
            enabled: true,
            window: {
              start: "01:00",
              end: "03:00",
              timezone: "local",
            },
            maintenanceAgents: ["maint"],
          },
        },
      }),
    ).not.toThrow();
  });

  it("rejects missing window when maintenance is enabled", () => {
    expect(() =>
      OpenClawSchema.parse({
        cron: {
          maintenance: {
            enabled: true,
            maintenanceAgents: ["maint"],
          },
        },
      }),
    ).toThrow(/maintenance.*window/i);
  });

  it("rejects invalid maintenance times", () => {
    expect(() =>
      OpenClawSchema.parse({
        cron: {
          maintenance: {
            enabled: true,
            window: {
              start: "24:00",
              end: "02:00",
            },
            maintenanceAgents: ["maint"],
          },
        },
      }),
    ).toThrow(/start/i);

    expect(() =>
      OpenClawSchema.parse({
        cron: {
          maintenance: {
            enabled: true,
            window: {
              start: "10:00",
              end: "10:00",
            },
            maintenanceAgents: ["maint"],
          },
        },
      }),
    ).toThrow(/start and end must differ/i);
  });

  it("rejects invalid maintenance timezone and empty allowlist entries", () => {
    expect(() =>
      OpenClawSchema.parse({
        cron: {
          maintenance: {
            enabled: true,
            window: {
              start: "10:00",
              end: "11:00",
              timezone: "Mars/OlympusMons",
            },
            maintenanceAgents: ["maint"],
          },
        },
      }),
    ).toThrow(/timezone/i);

    expect(() =>
      OpenClawSchema.parse({
        cron: {
          maintenance: {
            enabled: true,
            window: {
              start: "10:00",
              end: "11:00",
            },
            maintenanceAgents: [" ", "maint"],
          },
        },
      }),
    ).toThrow(/maintenance agent id must not be empty/i);
  });
});

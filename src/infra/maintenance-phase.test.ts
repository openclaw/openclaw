import { describe, expect, it } from "vitest";
import {
  resolveMaintenanceAgentAllowlist,
  resolveMaintenanceExecutionDecision,
  resolveMaintenancePhase,
} from "./maintenance-phase.js";

describe("maintenance phase resolver", () => {
  const cronConfig = {
    maintenance: {
      enabled: true,
      window: {
        start: "02:00",
        end: "04:00",
        timezone: "UTC",
      },
      maintenanceAgents: ["maint", " maint ", ""],
    },
  };

  it("normalizes maintenance agent allowlist", () => {
    expect(resolveMaintenanceAgentAllowlist(cronConfig)).toEqual(["maint"]);
  });

  it("returns maintenance phase inside configured window", () => {
    const now = Date.parse("2026-03-26T02:30:00.000Z");
    expect(resolveMaintenancePhase({ cronConfig, nowMs: now, userTimezone: "UTC" })).toBe(
      "maintenance",
    );
  });

  it("returns normal phase outside configured window", () => {
    const now = Date.parse("2026-03-26T05:30:00.000Z");
    expect(resolveMaintenancePhase({ cronConfig, nowMs: now, userTimezone: "UTC" })).toBe("normal");
  });

  it("allows only maintenance agents during maintenance phase", () => {
    const now = Date.parse("2026-03-26T03:00:00.000Z");
    expect(
      resolveMaintenanceExecutionDecision({
        cronConfig,
        nowMs: now,
        userTimezone: "UTC",
        agentId: "maint",
      }).allowed,
    ).toBe(true);
    expect(
      resolveMaintenanceExecutionDecision({
        cronConfig,
        nowMs: now,
        userTimezone: "UTC",
        agentId: "main",
      }).allowed,
    ).toBe(false);
  });

  it("blocks maintenance agents during normal phase", () => {
    const now = Date.parse("2026-03-26T06:00:00.000Z");
    expect(
      resolveMaintenanceExecutionDecision({
        cronConfig,
        nowMs: now,
        userTimezone: "UTC",
        agentId: "maint",
      }).allowed,
    ).toBe(false);
    expect(
      resolveMaintenanceExecutionDecision({
        cronConfig,
        nowMs: now,
        userTimezone: "UTC",
        agentId: "main",
      }).allowed,
    ).toBe(true);
  });
});

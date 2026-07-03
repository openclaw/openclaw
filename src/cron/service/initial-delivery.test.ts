import { describe, expect, it } from "vitest";
import type { CronDelivery, CronJobCreate, CronSchedule } from "../types.js";
import { resolveInitialCronDelivery } from "./initial-delivery.js";

const schedule: CronSchedule = { kind: "at", at: "2026-01-01T00:00:00Z" };

function agentTurn(overrides: Partial<CronJobCreate> = {}): CronJobCreate {
  return {
    name: "test-agent",
    enabled: true,
    schedule,
    sessionTarget: "main",
    wakeMode: "now",
    failureAlert: false,
    payload: { kind: "agentTurn", message: "hello" },
    ...overrides,
  };
}

function command(overrides: Partial<CronJobCreate> = {}): CronJobCreate {
  return {
    name: "test-cmd",
    enabled: true,
    schedule,
    sessionTarget: "main",
    wakeMode: "now",
    failureAlert: false,
    payload: { kind: "command", argv: ["echo", "hi"] },
    ...overrides,
  };
}

function systemEvent(overrides: Partial<CronJobCreate> = {}): CronJobCreate {
  return {
    name: "test-event",
    enabled: true,
    schedule,
    sessionTarget: "main",
    wakeMode: "now",
    failureAlert: false,
    payload: { kind: "systemEvent", text: "boot" },
    ...overrides,
  };
}

describe("resolveInitialCronDelivery", () => {
  it("returns explicit delivery unchanged", () => {
    const delivery: CronDelivery = { mode: "webhook", to: "https://example.com/hook" };
    expect(resolveInitialCronDelivery(agentTurn({ delivery }))).toBe(delivery);
  });

  // isolated
  it("defaults to announce for isolated agentTurn", () => {
    expect(resolveInitialCronDelivery(agentTurn({ sessionTarget: "isolated" }))).toEqual({
      mode: "announce",
    });
  });

  it("defaults to announce for isolated command", () => {
    expect(resolveInitialCronDelivery(command({ sessionTarget: "isolated" }))).toEqual({
      mode: "announce",
    });
  });

  // current
  it("defaults to announce for current agentTurn", () => {
    expect(resolveInitialCronDelivery(agentTurn({ sessionTarget: "current" }))).toEqual({
      mode: "announce",
    });
  });

  it("defaults to announce for current command", () => {
    expect(resolveInitialCronDelivery(command({ sessionTarget: "current" }))).toEqual({
      mode: "announce",
    });
  });

  // session:<id>
  it("defaults to announce for session:<id> agentTurn", () => {
    expect(resolveInitialCronDelivery(agentTurn({ sessionTarget: "session:abc-123" }))).toEqual({
      mode: "announce",
    });
  });

  it("defaults to announce for session:<id> command", () => {
    expect(resolveInitialCronDelivery(command({ sessionTarget: "session:abc-123" }))).toEqual({
      mode: "announce",
    });
  });

  // main
  it("returns undefined for main agentTurn (no default delivery)", () => {
    expect(resolveInitialCronDelivery(agentTurn({ sessionTarget: "main" }))).toBeUndefined();
  });

  it("returns undefined for main command (no default delivery)", () => {
    expect(resolveInitialCronDelivery(command({ sessionTarget: "main" }))).toBeUndefined();
  });

  // systemEvent never gets auto-delivery
  it("returns undefined for isolated systemEvent", () => {
    expect(resolveInitialCronDelivery(systemEvent({ sessionTarget: "isolated" }))).toBeUndefined();
  });

  it("returns undefined for current systemEvent", () => {
    expect(resolveInitialCronDelivery(systemEvent({ sessionTarget: "current" }))).toBeUndefined();
  });

  it("returns undefined for session:<id> systemEvent", () => {
    expect(
      resolveInitialCronDelivery(systemEvent({ sessionTarget: "session:abc-123" })),
    ).toBeUndefined();
  });
});

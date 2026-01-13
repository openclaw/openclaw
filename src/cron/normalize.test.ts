import { describe, expect, it } from "vitest";

import { normalizeCronJobCreate } from "./normalize.js";

describe("normalizeCronJobCreate", () => {
  it("maps legacy payload.channel to payload.provider and strips channel", () => {
    const normalized = normalizeCronJobCreate({
      name: "legacy",
      enabled: true,
      schedule: { kind: "cron", expr: "* * * * *" },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: {
        kind: "agentTurn",
        message: "hi",
        deliver: true,
        channel: " TeLeGrAm ",
        to: "7200373102",
      },
    }) as unknown as Record<string, unknown>;

    const payload = normalized.payload as Record<string, unknown>;
    expect(payload.provider).toBe("telegram");
    expect("channel" in payload).toBe(false);
  });

  it("normalizes agentId and drops null", () => {
    const normalized = normalizeCronJobCreate({
      name: "agent-set",
      enabled: true,
      schedule: { kind: "cron", expr: "* * * * *" },
      sessionTarget: "isolated",
      wakeMode: "now",
      agentId: " Ops ",
      payload: {
        kind: "agentTurn",
        message: "hi",
      },
    }) as unknown as Record<string, unknown>;

    expect(normalized.agentId).toBe("Ops");

    const cleared = normalizeCronJobCreate({
      name: "agent-clear",
      enabled: true,
      schedule: { kind: "cron", expr: "* * * * *" },
      sessionTarget: "isolated",
      wakeMode: "now",
      agentId: null,
      payload: {
        kind: "agentTurn",
        message: "hi",
      },
    }) as unknown as Record<string, unknown>;

    expect(cleared.agentId).toBeNull();
  });

  it("canonicalizes payload.provider casing", () => {
    const normalized = normalizeCronJobCreate({
      name: "legacy provider",
      enabled: true,
      schedule: { kind: "cron", expr: "* * * * *" },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: {
        kind: "agentTurn",
        message: "hi",
        deliver: true,
        provider: "Telegram",
        to: "7200373102",
      },
    }) as unknown as Record<string, unknown>;

    const payload = normalized.payload as Record<string, unknown>;
    expect(payload.provider).toBe("telegram");
  });

  it("coerces ISO schedule.at to atMs (UTC)", () => {
    const normalized = normalizeCronJobCreate({
      name: "iso at",
      enabled: true,
      schedule: { at: "2026-01-12T18:00:00" },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: {
        kind: "systemEvent",
        text: "hi",
      },
    }) as unknown as Record<string, unknown>;

    const schedule = normalized.schedule as Record<string, unknown>;
    expect(schedule.kind).toBe("at");
    expect(schedule.atMs).toBe(Date.parse("2026-01-12T18:00:00Z"));
  });

  it("coerces ISO schedule.atMs string to atMs (UTC)", () => {
    const normalized = normalizeCronJobCreate({
      name: "iso atMs",
      enabled: true,
      schedule: { kind: "at", atMs: "2026-01-12T18:00:00" },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: {
        kind: "systemEvent",
        text: "hi",
      },
    }) as unknown as Record<string, unknown>;

    const schedule = normalized.schedule as Record<string, unknown>;
    expect(schedule.kind).toBe("at");
    expect(schedule.atMs).toBe(Date.parse("2026-01-12T18:00:00Z"));
  });
});

import { describe, expect, it } from "vitest";
import { normalizeCronJobCreate } from "./normalize.js";

describe("normalizeCronJobCreate", () => {
  it("maps legacy payload.provider to payload.channel and strips provider", () => {
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
        provider: " TeLeGrAm ",
        to: "7200373102",
      },
    }) as unknown as Record<string, unknown>;

    const payload = normalized.payload as Record<string, unknown>;
    expect(payload.channel).toBeUndefined();
    expect(payload.deliver).toBeUndefined();
    expect("provider" in payload).toBe(false);

    const delivery = normalized.delivery as Record<string, unknown>;
    expect(delivery.mode).toBe("announce");
    expect(delivery.channel).toBe("telegram");
    expect(delivery.to).toBe("7200373102");
  });

  it("trims agentId and drops null", () => {
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

    expect(normalized.agentId).toBe("ops");

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

  it("canonicalizes payload.channel casing", () => {
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
        channel: "Telegram",
        to: "7200373102",
      },
    }) as unknown as Record<string, unknown>;

    const payload = normalized.payload as Record<string, unknown>;
    expect(payload.channel).toBeUndefined();
    expect(payload.deliver).toBeUndefined();

    const delivery = normalized.delivery as Record<string, unknown>;
    expect(delivery.mode).toBe("announce");
    expect(delivery.channel).toBe("telegram");
    expect(delivery.to).toBe("7200373102");
  });

  it("coerces ISO schedule.at to normalized ISO (UTC)", () => {
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
    expect(schedule.at).toBe(new Date(Date.parse("2026-01-12T18:00:00Z")).toISOString());
  });

  it("coerces schedule.atMs string to schedule.at (UTC)", () => {
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
    expect(schedule.at).toBe(new Date(Date.parse("2026-01-12T18:00:00Z")).toISOString());
  });

  it("defaults deleteAfterRun for one-shot schedules", () => {
    const normalized = normalizeCronJobCreate({
      name: "default delete",
      enabled: true,
      schedule: { at: "2026-01-12T18:00:00Z" },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: {
        kind: "systemEvent",
        text: "hi",
      },
    }) as unknown as Record<string, unknown>;

    expect(normalized.deleteAfterRun).toBe(true);
  });

  it("normalizes delivery mode and channel", () => {
    const normalized = normalizeCronJobCreate({
      name: "delivery",
      enabled: true,
      schedule: { kind: "cron", expr: "* * * * *" },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: {
        kind: "agentTurn",
        message: "hi",
      },
      delivery: {
        mode: " ANNOUNCE ",
        channel: " TeLeGrAm ",
        to: " 7200373102 ",
      },
    }) as unknown as Record<string, unknown>;

    const delivery = normalized.delivery as Record<string, unknown>;
    expect(delivery.mode).toBe("announce");
    expect(delivery.channel).toBe("telegram");
    expect(delivery.to).toBe("7200373102");
  });

  it("defaults isolated agentTurn delivery to announce", () => {
    const normalized = normalizeCronJobCreate({
      name: "default-announce",
      enabled: true,
      schedule: { kind: "cron", expr: "* * * * *" },
      payload: {
        kind: "agentTurn",
        message: "hi",
      },
    }) as unknown as Record<string, unknown>;

    const delivery = normalized.delivery as Record<string, unknown>;
    expect(delivery.mode).toBe("announce");
  });

  it("migrates legacy delivery fields to delivery", () => {
    const normalized = normalizeCronJobCreate({
      name: "legacy deliver",
      enabled: true,
      schedule: { kind: "cron", expr: "* * * * *" },
      payload: {
        kind: "agentTurn",
        message: "hi",
        deliver: true,
        channel: "telegram",
        to: "7200373102",
        bestEffortDeliver: true,
      },
    }) as unknown as Record<string, unknown>;

    const delivery = normalized.delivery as Record<string, unknown>;
    expect(delivery.mode).toBe("announce");
    expect(delivery.channel).toBe("telegram");
    expect(delivery.to).toBe("7200373102");
    expect(delivery.bestEffort).toBe(true);
  });

  it("maps legacy deliver=false to delivery none", () => {
    const normalized = normalizeCronJobCreate({
      name: "legacy off",
      enabled: true,
      schedule: { kind: "cron", expr: "* * * * *" },
      payload: {
        kind: "agentTurn",
        message: "hi",
        deliver: false,
        channel: "telegram",
        to: "7200373102",
      },
    }) as unknown as Record<string, unknown>;

    const delivery = normalized.delivery as Record<string, unknown>;
    expect(delivery.mode).toBe("none");
  });

  it("migrates legacy isolation settings to announce delivery", () => {
    const normalized = normalizeCronJobCreate({
      name: "legacy isolation",
      enabled: true,
      schedule: { kind: "cron", expr: "* * * * *" },
      payload: {
        kind: "agentTurn",
        message: "hi",
      },
      isolation: { postToMainPrefix: "Cron" },
    }) as unknown as Record<string, unknown>;

    const delivery = normalized.delivery as Record<string, unknown>;
    expect(delivery.mode).toBe("announce");
    expect((normalized as { isolation?: unknown }).isolation).toBeUndefined();
  });
});

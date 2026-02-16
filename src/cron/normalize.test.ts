import { describe, expect, it } from "vitest";
import { normalizeCronJobCreate, normalizeCronJobPatch } from "./normalize.js";

function expectNormalizedAtSchedule(scheduleInput: Record<string, unknown>) {
  const normalized = normalizeCronJobCreate({
    name: "iso schedule",
    enabled: true,
    schedule: scheduleInput,
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
}

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
    expectNormalizedAtSchedule({ at: "2026-01-12T18:00:00" });
  });

  it("coerces schedule.atMs string to schedule.at (UTC)", () => {
    expectNormalizedAtSchedule({ kind: "at", atMs: "2026-01-12T18:00:00" });
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

  it("normalizes webhook delivery mode and target URL", () => {
    const normalized = normalizeCronJobCreate({
      name: "webhook delivery",
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "main",
      wakeMode: "now",
      payload: { kind: "systemEvent", text: "hello" },
      delivery: {
        mode: " WeBhOoK ",
        to: " https://example.invalid/cron ",
      },
    }) as unknown as Record<string, unknown>;

    const delivery = normalized.delivery as Record<string, unknown>;
    expect(delivery.mode).toBe("webhook");
    expect(delivery.to).toBe("https://example.invalid/cron");
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

  it("infers payload kind/session target and name for message-only jobs", () => {
    const normalized = normalizeCronJobCreate({
      schedule: { kind: "every", everyMs: 60_000 },
      payload: { message: "Nightly backup" },
    }) as unknown as Record<string, unknown>;

    const payload = normalized.payload as Record<string, unknown>;
    expect(payload.kind).toBe("agentTurn");
    expect(payload.message).toBe("Nightly backup");
    expect(normalized.sessionTarget).toBe("isolated");
    expect(normalized.wakeMode).toBe("now");
    expect(typeof normalized.name).toBe("string");
  });

  it("maps top-level model/thinking/timeout into payload for legacy add params", () => {
    const normalized = normalizeCronJobCreate({
      name: "legacy root fields",
      schedule: { kind: "every", everyMs: 60_000 },
      payload: { kind: "agentTurn", message: "hello" },
      model: " openrouter/deepseek/deepseek-r1 ",
      thinking: " high ",
      timeoutSeconds: 45,
      allowUnsafeExternalContent: true,
    }) as unknown as Record<string, unknown>;

    const payload = normalized.payload as Record<string, unknown>;
    expect(payload.model).toBe("openrouter/deepseek/deepseek-r1");
    expect(payload.thinking).toBe("high");
    expect(payload.timeoutSeconds).toBe(45);
    expect(payload.allowUnsafeExternalContent).toBe(true);
  });

  it("coerces sessionTarget and wakeMode casing", () => {
    const normalized = normalizeCronJobCreate({
      name: "casing",
      schedule: { kind: "cron", expr: "* * * * *" },
      sessionTarget: " IsOlAtEd ",
      wakeMode: " NOW ",
      payload: { kind: "agentTurn", message: "hello" },
    }) as unknown as Record<string, unknown>;

    expect(normalized.sessionTarget).toBe("isolated");
    expect(normalized.wakeMode).toBe("now");
  });

  it("strips invalid delivery mode from partial delivery objects", () => {
    const normalized = normalizeCronJobCreate({
      name: "delivery mode",
      schedule: { kind: "cron", expr: "* * * * *" },
      payload: { kind: "agentTurn", message: "hello" },
      delivery: { mode: "bogus", to: "123" },
    }) as unknown as Record<string, unknown>;

    const delivery = normalized.delivery as Record<string, unknown>;
    expect(delivery.mode).toBeUndefined();
    expect(delivery.to).toBe("123");
  });
});

describe("normalizeCronJobPatch", () => {
  it("infers agentTurn kind for model-only payload patches", () => {
    const normalized = normalizeCronJobPatch({
      payload: {
        model: "anthropic/claude-sonnet-4-5",
      },
    }) as unknown as Record<string, unknown>;

    const payload = normalized.payload as Record<string, unknown>;
    expect(payload.kind).toBe("agentTurn");
    expect(payload.model).toBe("anthropic/claude-sonnet-4-5");
  });

  it("does not infer agentTurn kind for delivery-only legacy hints", () => {
    const normalized = normalizeCronJobPatch({
      payload: {
        channel: "telegram",
        to: "+15550001111",
      },
    }) as unknown as Record<string, unknown>;

    const payload = normalized.payload as Record<string, unknown>;
    expect(payload.kind).toBeUndefined();
    expect(payload.channel).toBe("telegram");
    expect(payload.to).toBe("+15550001111");
  });
});

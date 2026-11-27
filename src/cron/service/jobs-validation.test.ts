import { describe, expect, it } from "vitest";
import {
  assertExternalSourceScheduleSupport,
  assertSupportedJobSpec,
  assertTriggerSupport,
} from "./jobs-validation.js";

describe("cron target and payload guidance", () => {
  it.each(["main", "current"])("rejects the retired %s target", (sessionTarget) => {
    expect(() =>
      assertSupportedJobSpec({
        sessionTarget: sessionTarget as never,
        payload: { kind: "agentTurn" },
      }),
    ).toThrow('Expected cron sessionTarget "isolated" or "session:<key>"');
  });

  it.each(["agentTurn", "systemEvent", "command", "script"] as const)(
    "accepts %s with an explicit conversation target",
    (kind) => {
      expect(() =>
        assertSupportedJobSpec({
          sessionTarget: "session:agent:main:continuation",
          payload: { kind },
        }),
      ).not.toThrow();
    },
  );

  it("requires an explicit conversation for system events", () => {
    expect(() =>
      assertSupportedJobSpec({ sessionTarget: "isolated", payload: { kind: "systemEvent" } }),
    ).toThrow("A system event requires an explicit conversation");
  });
});

describe("event source schedule validation", () => {
  it("validates source definitions and agent-turn payloads without widening target validation", () => {
    const schedule = { kind: "event" as const, source: "mcp-events", options: {} };
    expect(() =>
      assertExternalSourceScheduleSupport({
        schedule,
        payload: { kind: "agentTurn", message: "Handle the event." },
      }),
    ).not.toThrow();
    expect(() =>
      assertExternalSourceScheduleSupport({
        schedule: { ...schedule, source: "invalid source" },
        payload: { kind: "agentTurn", message: "Handle the event." },
      }),
    ).toThrow("event schedules require");
    expect(() =>
      assertExternalSourceScheduleSupport({
        schedule,
        payload: { kind: "command", argv: ["echo", "event"] },
      }),
    ).toThrow("event schedules require");
  });
});

const triggerJob = {
  schedule: { kind: "every" as const, everyMs: 30_000 },
  trigger: { script: "json({ fire: true })" },
};

describe("cron trigger enablement", () => {
  it("allows triggers by default when cron.triggers is omitted", () => {
    expect(() =>
      assertTriggerSupport(triggerJob, {
        cronConfig: {},
        validateAuthoredTrigger: true,
      }),
    ).not.toThrow();
  });

  it("rejects triggers when the operator explicitly opts out", () => {
    expect(() =>
      assertTriggerSupport(triggerJob, {
        cronConfig: { triggers: { enabled: false } },
        validateAuthoredTrigger: true,
      }),
    ).toThrow(
      "cron triggers are disabled because the operator set cron.triggers.enabled: false; remove it or set it to true",
    );
  });
});

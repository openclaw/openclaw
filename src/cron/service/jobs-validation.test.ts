import { describe, expect, it } from "vitest";
import { assertSupportedJobSpec, assertTriggerSupport } from "./jobs-validation.js";

describe("cron target and payload guidance", () => {
  it.each(["current", "session:agent:main:dashboard:continuation"] as const)(
    "names %s and the agent-turn fix for a system event",
    (sessionTarget) => {
      expect(() =>
        assertSupportedJobSpec({ sessionTarget, payload: { kind: "systemEvent" } }),
      ).toThrow(
        `cron sessionTarget "${sessionTarget}" cannot run systemEvent: systemEvent only runs in the main session; for sessionTarget "${sessionTarget}" use payload {kind:"agentTurn",message}`,
      );
    },
  );

  it.each(["current", "session:agent:main:dashboard:continuation"] as const)(
    "explains headless scripts and the conversation-turn fix for %s",
    (sessionTarget) => {
      expect(() => assertSupportedJobSpec({ sessionTarget, payload: { kind: "script" } })).toThrow(
        `cron sessionTarget "${sessionTarget}" cannot run script payloads: scripts run headless and support only "main" or "isolated"; to run a turn in an existing conversation use payload {kind:"agentTurn",message} with sessionTarget "session:<key>"`,
      );
    },
  );

  it("names the valid payloads for isolated jobs", () => {
    expect(() =>
      assertSupportedJobSpec({ sessionTarget: "isolated", payload: { kind: "systemEvent" } }),
    ).toThrow(
      'cron sessionTarget "isolated" requires payload.kind="agentTurn", "command", or "script"',
    );
  });

  it("accepts main-session agent turns and rejects command payloads", () => {
    expect(() =>
      assertSupportedJobSpec({ sessionTarget: "main", payload: { kind: "agentTurn" } }),
    ).not.toThrow();
    expect(() =>
      assertSupportedJobSpec({ sessionTarget: "main", payload: { kind: "command" } }),
    ).toThrow(
      'cron sessionTarget "main" requires payload.kind="systemEvent", "agentTurn", or "script"',
    );
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

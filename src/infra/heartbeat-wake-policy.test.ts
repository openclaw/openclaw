import { describe, expect, it } from "vitest";
import { isPeriodicHeartbeatWake } from "./heartbeat-wake-policy.js";

describe("isPeriodicHeartbeatWake (#153543)", () => {
  it.each([
    { name: "an ambient poll with no source", source: undefined },
    { name: "a scheduled interval tick", source: "interval" as const },
    { name: "an operator-run trigger", source: "manual" as const },
  ])("treats $name as the agent's own heartbeat check", ({ source }) => {
    expect(isPeriodicHeartbeatWake({ source })).toBe(true);
  });

  // Each of these executes on the heartbeat runner but is not a heartbeat check.
  it.each([
    "exec-event",
    "cron",
    "hook",
    "background-task",
    "background-task-blocked",
    "acp-spawn",
    "session-state",
    "notifications-event",
    "restart-sentinel",
    "cli-watchdog",
    "retry",
    "other",
  ] as const)("treats a %s wake as borrowed transport", (source) => {
    expect(isPeriodicHeartbeatWake({ source })).toBe(false);
  });

  // A scheduled tick keeps heartbeat identity even when the scheduler labels its
  // source, matching the provenance rule this replaced.
  it("treats a scheduled intent as a heartbeat regardless of source", () => {
    expect(isPeriodicHeartbeatWake({ source: "hook", intent: "scheduled" })).toBe(true);
  });

  it("does not let other intents claim heartbeat identity", () => {
    expect(isPeriodicHeartbeatWake({ source: "background-task", intent: "immediate" })).toBe(false);
    expect(isPeriodicHeartbeatWake({ source: "exec-event", intent: "event" })).toBe(false);
  });
});

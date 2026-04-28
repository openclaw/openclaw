import { describe, expect, it } from "vitest";
import {
  isHeartbeatActionWakeReason,
  isHeartbeatEventDrivenReason,
  normalizeHeartbeatWakeReason,
  resolveHeartbeatReasonKind,
} from "./heartbeat-reason.js";

describe("heartbeat-reason", () => {
  it.each([
    { value: "  cron:job-1  ", expected: "cron:job-1" },
    { value: "  ", expected: "requested" },
    { value: undefined, expected: "requested" },
  ])("normalizes wake reasons for %j", ({ value, expected }) => {
    expect(normalizeHeartbeatWakeReason(value)).toBe(expected);
  });

  it.each([
    { value: "retry", expected: "retry" },
    { value: "interval", expected: "interval" },
    { value: "manual", expected: "manual" },
    { value: "exec-event", expected: "exec-event" },
    { value: "wake", expected: "wake" },
    { value: "acp:spawn:stream", expected: "wake" },
    { value: "acp:spawn:", expected: "wake" },
    { value: "cron:job-1", expected: "cron" },
    { value: "hook:wake", expected: "hook" },
    { value: "  hook:wake  ", expected: "hook" },
    { value: "requested", expected: "other" },
    { value: "slow", expected: "other" },
    { value: "", expected: "other" },
    { value: undefined, expected: "other" },
    // --- FORK regression: exec completion reasons ---
    { value: "exec:dawn-coral:exit", expected: "exec-event" },
    { value: "exec:warm-rook:signal", expected: "exec-event" },
    { value: "exec:abc123:exit", expected: "exec-event" },
    // --- FORK regression: background-task reasons ---
    { value: "background-task", expected: "wake" },
    { value: "background-task-blocked", expected: "wake" },
    // --- FORK regression: acp prefix reasons ---
    { value: "acp:completion:123", expected: "wake" },
    { value: "acp:result", expected: "wake" },
  ])("classifies reason kinds for %j", ({ value, expected }) => {
    expect(resolveHeartbeatReasonKind(value)).toBe(expected);
  });

  it.each([
    { value: "exec-event", expected: true },
    { value: "cron:job-1", expected: true },
    { value: "wake", expected: true },
    { value: "acp:spawn:stream", expected: true },
    { value: "hook:gmail:sync", expected: true },
    { value: "interval", expected: false },
    { value: "manual", expected: false },
    { value: "other", expected: false },
    // --- FORK regression: these must be event-driven to bypass isolatedSession ---
    { value: "exec:dawn-coral:exit", expected: true },
    { value: "background-task", expected: true },
    { value: "background-task-blocked", expected: true },
    { value: "acp:completion:123", expected: true },
  ])("matches event-driven behavior for %j", ({ value, expected }) => {
    expect(isHeartbeatEventDrivenReason(value)).toBe(expected);
  });

  it.each([
    { value: "manual", expected: true },
    { value: "exec-event", expected: true },
    { value: "hook:wake", expected: true },
    { value: "interval", expected: false },
    { value: "cron:job-1", expected: false },
    { value: "retry", expected: false },
    // --- FORK regression: exec completions are action wakes ---
    { value: "exec:dawn-coral:exit", expected: true },
    // background-task is NOT an action wake (it's a passive event)
    { value: "background-task", expected: false },
  ])("matches action-priority wake behavior for %j", ({ value, expected }) => {
    expect(isHeartbeatActionWakeReason(value)).toBe(expected);
  });

  // --- FORK regression: no reason should create :heartbeat:heartbeat ---
  // Any reason that targets an existing session must be classified as
  // event-driven (exec-event, cron, wake, hook) so isolatedSession is skipped.
  describe("no :heartbeat recursion (fork regression)", () => {
    const eventReasons = [
      "exec-event",
      "exec:dawn-coral:exit",
      "exec:warm-rook:signal",
      "background-task",
      "background-task-blocked",
      "cron:f6f9dc1f-664f-4485-9349-4a25744cec8b",
      "acp:spawn:stream",
      "acp:completion:abc",
      "hook:gmail:sync",
      "wake",
    ];

    it.each(eventReasons)(
      "reason %j must bypass isolatedSession (event-driven=true)",
      (reason) => {
        expect(isHeartbeatEventDrivenReason(reason)).toBe(true);
      },
    );

    const intervalReasons = ["interval", "retry"];
    it.each(intervalReasons)(
      "reason %j should use isolatedSession (event-driven=false)",
      (reason) => {
        expect(isHeartbeatEventDrivenReason(reason)).toBe(false);
      },
    );
  });
});

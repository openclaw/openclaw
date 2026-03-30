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
    { value: "exec:abc12345:exit", expected: "exec-event" },
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
  ])("classifies reason kinds for %j", ({ value, expected }) => {
    expect(resolveHeartbeatReasonKind(value)).toBe(expected);
  });

  it.each([
    { value: "exec-event", expected: true },
    { value: "exec:faint-pine:exit", expected: true },
    { value: "cron:job-1", expected: true },
    { value: "wake", expected: true },
    { value: "acp:spawn:stream", expected: true },
    { value: "hook:gmail:sync", expected: true },
    { value: "interval", expected: false },
    { value: "manual", expected: false },
    { value: "other", expected: false },
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
  ])("matches action-priority wake behavior for %j", ({ value, expected }) => {
    expect(isHeartbeatActionWakeReason(value)).toBe(expected);
  });
});

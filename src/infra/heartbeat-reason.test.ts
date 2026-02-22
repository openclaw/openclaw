import { describe, expect, it } from "vitest";
import {
  isHeartbeatActionWakeReason,
  isHeartbeatEventDrivenReason,
  normalizeHeartbeatWakeReason,
  resolveHeartbeatReasonKind,
} from "./heartbeat-reason.js";

describe("heartbeat-reason", () => {
  it("normalizes wake reasons with trim + requested fallback", () => {
    expect(normalizeHeartbeatWakeReason("  cron:job-1  ")).toBe("cron:job-1");
    expect(normalizeHeartbeatWakeReason("  ")).toBe("requested");
    expect(normalizeHeartbeatWakeReason(undefined)).toBe("requested");
  });

  it("classifies known reason kinds", () => {
    expect(resolveHeartbeatReasonKind("retry")).toBe("retry");
    expect(resolveHeartbeatReasonKind("interval")).toBe("interval");
    expect(resolveHeartbeatReasonKind("manual")).toBe("manual");
    expect(resolveHeartbeatReasonKind("exec-event")).toBe("exec-event");
    expect(resolveHeartbeatReasonKind("wake")).toBe("wake");
    expect(resolveHeartbeatReasonKind("cron:job-1")).toBe("cron");
    expect(resolveHeartbeatReasonKind("hook:wake")).toBe("hook");
    expect(resolveHeartbeatReasonKind("  hook:wake  ")).toBe("hook");
  });

  it("classifies unknown reasons as other", () => {
    expect(resolveHeartbeatReasonKind("requested")).toBe("other");
    expect(resolveHeartbeatReasonKind("slow")).toBe("other");
    expect(resolveHeartbeatReasonKind("")).toBe("other");
    expect(resolveHeartbeatReasonKind(undefined)).toBe("other");
  });

  it("matches event-driven behavior used by heartbeat preflight", () => {
    expect(isHeartbeatEventDrivenReason("exec-event")).toBe(true);
    expect(isHeartbeatEventDrivenReason("cron:job-1")).toBe(true);
    expect(isHeartbeatEventDrivenReason("wake")).toBe(true);
    expect(isHeartbeatEventDrivenReason("hook:gmail:sync")).toBe(true);
    expect(isHeartbeatEventDrivenReason("interval")).toBe(false);
    expect(isHeartbeatEventDrivenReason("manual")).toBe(false);
    expect(isHeartbeatEventDrivenReason("other")).toBe(false);
  });

  it("matches action-priority wake behavior", () => {
    expect(isHeartbeatActionWakeReason("manual")).toBe(true);
    expect(isHeartbeatActionWakeReason("exec-event")).toBe(true);
    expect(isHeartbeatActionWakeReason("hook:wake")).toBe(true);
    expect(isHeartbeatActionWakeReason("interval")).toBe(false);
    expect(isHeartbeatActionWakeReason("cron:job-1")).toBe(false);
    expect(isHeartbeatActionWakeReason("retry")).toBe(false);
  });
});

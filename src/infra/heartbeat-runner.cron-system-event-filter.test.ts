import { describe, expect, it } from "vitest";
import { isCronSystemEvent } from "./heartbeat-runner.js";

describe("isCronSystemEvent", () => {
  it("returns false for empty entries", () => {
    expect(isCronSystemEvent("")).toBe(false);
    expect(isCronSystemEvent("   ")).toBe(false);
  });

  it("returns false for heartbeat ack markers", () => {
    expect(isCronSystemEvent("HEARTBEAT_OK")).toBe(false);
    expect(isCronSystemEvent("HEARTBEAT_OK 🦞")).toBe(false);
    expect(isCronSystemEvent("heartbeat_ok")).toBe(false);
    expect(isCronSystemEvent("HEARTBEAT_OK:")).toBe(false);
    expect(isCronSystemEvent("HEARTBEAT_OK, continue")).toBe(false);
  });

  it("returns false for heartbeat poll and wake noise", () => {
    expect(isCronSystemEvent("heartbeat poll: pending")).toBe(false);
    expect(isCronSystemEvent("heartbeat wake complete")).toBe(false);
  });

  it("returns false for exec completion events", () => {
    expect(isCronSystemEvent("Exec finished (gateway id=abc, code 0)")).toBe(false);
  });

  it("returns true for real cron reminder content", () => {
    expect(isCronSystemEvent("Reminder: Check Base Scout results")).toBe(true);
    expect(isCronSystemEvent("Send weekly status update to the team")).toBe(true);
  });
});

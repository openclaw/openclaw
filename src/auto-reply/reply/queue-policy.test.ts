import { describe, expect, it } from "vitest";
import { buildQueuedBusyReceipt, resolveActiveRunQueueAction } from "./queue-policy.js";

describe("resolveActiveRunQueueAction", () => {
  it("runs immediately when there is no active run", () => {
    expect(
      resolveActiveRunQueueAction({
        isActive: false,
        isHeartbeat: false,
        shouldFollowup: true,
        queueMode: "collect",
      }),
    ).toBe("run-now");
  });

  it("drops heartbeat runs while another run is active", () => {
    expect(
      resolveActiveRunQueueAction({
        isActive: true,
        isHeartbeat: true,
        shouldFollowup: true,
        queueMode: "collect",
      }),
    ).toBe("drop");
  });

  it("enqueues followups for non-heartbeat active runs", () => {
    expect(
      resolveActiveRunQueueAction({
        isActive: true,
        isHeartbeat: false,
        shouldFollowup: true,
        queueMode: "collect",
      }),
    ).toBe("enqueue-followup");
  });

  it("enqueues steer mode runs while active", () => {
    expect(
      resolveActiveRunQueueAction({
        isActive: true,
        isHeartbeat: false,
        shouldFollowup: false,
        queueMode: "steer",
      }),
    ).toBe("enqueue-followup");
  });
});

describe("buildQueuedBusyReceipt", () => {
  it("returns a short busy receipt for the first queued message", () => {
    expect(buildQueuedBusyReceipt({ depth: 1 }).text).toContain("queued");
    expect(buildQueuedBusyReceipt({ depth: 1 }).text).toContain("follow up shortly");
    expect(buildQueuedBusyReceipt({ depth: 1 }).text.length).toBeLessThan(120);
  });

  it("includes queued-ahead count when backlog already exists", () => {
    expect(buildQueuedBusyReceipt({ depth: 3 }).text).toContain("2 ahead");
  });
});

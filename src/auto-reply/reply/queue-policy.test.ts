import { describe, expect, it } from "vitest";
import { resolveActiveRunQueueAction } from "./queue-policy.js";

describe("resolveActiveRunQueueAction", () => {
  it("runs immediately when there is no active run", () => {
    expect(
      resolveActiveRunQueueAction({
        isActive: false,
        hasQueuedFollowups: false,
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
        hasQueuedFollowups: false,
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
        hasQueuedFollowups: false,
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
        hasQueuedFollowups: false,
        isHeartbeat: false,
        shouldFollowup: false,
        queueMode: "steer",
      }),
    ).toBe("enqueue-followup");
  });

  it("enqueues followups when queue is already busy even if run is not active", () => {
    expect(
      resolveActiveRunQueueAction({
        isActive: false,
        hasQueuedFollowups: true,
        isHeartbeat: false,
        shouldFollowup: true,
        queueMode: "collect",
      }),
    ).toBe("enqueue-followup");
  });
});

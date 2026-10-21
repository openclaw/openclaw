// Tests queue policy parsing and admission decisions.
import { describe, expect, it } from "vitest";
import { resolveActiveRunQueueAction } from "./queue-policy.js";

describe("resolveActiveRunQueueAction", () => {
  it.each([
    { hasQueuedFollowups: false, action: "run-now" },
    { hasQueuedFollowups: true, action: "enqueue-followup" },
  ] as const)(
    "keeps waiting followups ahead of new turns when idle (backlog=$hasQueuedFollowups)",
    ({ hasQueuedFollowups, action }) => {
      expect(
        resolveActiveRunQueueAction({
          hasQueuedFollowups,
          isActive: false,
          isHeartbeat: false,
          shouldFollowup: true,
        }),
      ).toBe(action);
    },
  );

  it("enqueues followups for non-heartbeat active runs", () => {
    expect(
      resolveActiveRunQueueAction({
        isActive: true,
        isHeartbeat: false,
        shouldFollowup: true,
      }),
    ).toBe("enqueue-followup");
  });

  it("runs interrupts ahead of queued followups", () => {
    expect(
      resolveActiveRunQueueAction({
        hasQueuedFollowups: true,
        isActive: true,
        interrupt: true,
        isHeartbeat: false,
        shouldFollowup: false,
      }),
    ).toBe("run-now");
  });

  it.each(["steer", "followup", "collect"] as const)(
    "enqueues %s turns behind queued followups",
    (mode) => {
      expect(
        resolveActiveRunQueueAction({
          hasQueuedFollowups: true,
          isActive: true,
          isHeartbeat: false,
          shouldFollowup: mode === "steer" || mode === "followup" || mode === "collect",
        }),
      ).toBe("enqueue-followup");
    },
  );

  it("drops heartbeats while an active run has queued followups", () => {
    expect(
      resolveActiveRunQueueAction({
        hasQueuedFollowups: true,
        isActive: true,
        isHeartbeat: true,
        shouldFollowup: true,
      }),
    ).toBe("drop");
  });

  it("runs reset-triggered turns immediately while another run is active", () => {
    expect(
      resolveActiveRunQueueAction({
        isActive: true,
        isHeartbeat: false,
        shouldFollowup: true,
        resetTriggered: true,
      }),
    ).toBe("run-now");
  });

  it("keeps heartbeat drops ahead of reset-triggered turns", () => {
    expect(
      resolveActiveRunQueueAction({
        isActive: true,
        isHeartbeat: true,
        shouldFollowup: true,
        resetTriggered: true,
      }),
    ).toBe("drop");
  });
});

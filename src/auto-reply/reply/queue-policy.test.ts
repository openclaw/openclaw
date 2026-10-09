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

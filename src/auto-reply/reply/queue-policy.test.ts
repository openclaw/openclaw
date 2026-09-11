// Tests queue policy parsing and admission decisions.
import { describe, expect, it } from "vitest";
import { resolveActiveRunQueueAction, resolveReplyQueueAdmissionState } from "./queue-policy.js";
import { createQueueTestRun } from "./queue.test-helpers.js";

describe("resolveReplyQueueAdmissionState", () => {
  it("opens steering after a queued turn takes execution ownership", () => {
    const item = createQueueTestRun({ prompt: "queued request" });
    const queue = { items: [item], inFlight: new Set([item]), droppedCount: 0 };
    expect(resolveReplyQueueAdmissionState(queue, undefined)).toBe("ready");
    expect(resolveReplyQueueAdmissionState(queue, { turnKind: "visible", result: null })).toBe(
      "ready",
    );
    const active = { turnKind: "queued_followup", result: null } as const;
    expect(resolveReplyQueueAdmissionState(queue, active)).toBe("steering");
    // Durable admission may remove the item before the running drain settles.
    queue.items.length = 0;
    expect(resolveReplyQueueAdmissionState(queue, active)).toBe("steering");
    expect(
      resolveReplyQueueAdmissionState(queue, {
        turnKind: "queued_followup",
        result: { kind: "completed" },
      }),
    ).toBe("ready");
  });

  it("preserves the order of messages and overflow waiting behind a queued turn", () => {
    const running = createQueueTestRun({ prompt: "running request" });
    const waiting = createQueueTestRun({ prompt: "earlier waiting request" });
    const queue = { items: [running, waiting], inFlight: new Set([running]), droppedCount: 0 };
    const active = { turnKind: "queued_followup", result: null } as const;
    expect(resolveReplyQueueAdmissionState(queue, active)).toBe("ready");
    queue.items.pop();
    queue.droppedCount = 1;
    expect(resolveReplyQueueAdmissionState(queue, active)).toBe("ready");
  });
});

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

  it("runs reset-triggered turns immediately while another run is active", () => {
    for (const queueMode of ["collect", "followup"] as const) {
      expect(
        resolveActiveRunQueueAction({
          isActive: true,
          isHeartbeat: false,
          shouldFollowup: true,
          queueMode,
          resetTriggered: true,
        }),
      ).toBe("run-now");
    }
  });

  it("keeps heartbeat drops ahead of reset-triggered turns", () => {
    expect(
      resolveActiveRunQueueAction({
        isActive: true,
        isHeartbeat: true,
        shouldFollowup: true,
        queueMode: "followup",
        resetTriggered: true,
      }),
    ).toBe("drop");
  });

  it("ignores reset-triggered policy when there is no active run", () => {
    expect(
      resolveActiveRunQueueAction({
        isActive: false,
        isHeartbeat: false,
        shouldFollowup: true,
        queueMode: "collect",
        resetTriggered: true,
      }),
    ).toBe("run-now");
  });
});

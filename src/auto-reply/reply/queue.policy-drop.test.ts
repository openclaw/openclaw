import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { enqueueFollowupRun } from "./queue.js";
import { createQueueTestRun, createQueueSettings } from "./queue.test-helpers.js";
import { clearFollowupQueue } from "./queue/state.js";

describe("followup queue policy drop", () => {
  it("settles a queue-cap old victim as a policy drop, not abandonment", async () => {
    const key = `test-drop-old-ingress-${Date.now()}`;
    const settings = createQueueSettings({ mode: "followup", cap: 1, dropPolicy: "old" });
    const dropCommit = createDeferred();
    const dropped = vi.fn(async () => {
      await dropCommit.promise;
    });
    const abandoned = vi.fn();
    const victim = createQueueTestRun({ prompt: "victim" });
    victim.turnAdoptionLifecycle = {
      admission: "exclusive",
      onAdopted: vi.fn(),
      onDropped: dropped,
      onAbandoned: abandoned,
    };
    try {
      expect(enqueueFollowupRun(key, victim, settings)).toBe(true);
      expect(enqueueFollowupRun(key, createQueueTestRun({ prompt: "survivor" }), settings)).toBe(
        true,
      );
      expect(dropped).toHaveBeenCalledExactlyOnceWith("queue-cap-old");
      expect(abandoned).not.toHaveBeenCalled();
      const settled = vi.fn();
      void victim.controllerInput!.settlement.promise.then(settled);
      await Promise.resolve();
      expect(settled).not.toHaveBeenCalled();
      dropCommit.resolve();
      await victim.controllerInput!.settlement.promise;
      expect(settled).toHaveBeenCalledOnce();
    } finally {
      clearFollowupQueue(key);
    }
  });

  it("settles a rejected drop:new source without enqueueing or abandoning it", async () => {
    const key = `test-drop-new-ingress-${Date.now()}`;
    const settings = createQueueSettings({ mode: "followup", cap: 1, dropPolicy: "new" });
    const dropped = vi.fn();
    const abandoned = vi.fn();
    const rejected = createQueueTestRun({ prompt: "rejected" });
    rejected.turnAdoptionLifecycle = {
      admission: "exclusive",
      onAdopted: vi.fn(),
      onDropped: dropped,
      onAbandoned: abandoned,
    };
    try {
      expect(enqueueFollowupRun(key, createQueueTestRun({ prompt: "existing" }), settings)).toBe(
        true,
      );
      expect(enqueueFollowupRun(key, rejected, settings)).toBe(false);
      await rejected.controllerInput!.settlement.promise;
      expect(dropped).toHaveBeenCalledExactlyOnceWith("queue-cap-new");
      expect(abandoned).not.toHaveBeenCalled();
    } finally {
      clearFollowupQueue(key);
    }
  });

  it("releases an all-protected queue refusal for retry instead of dropping it", async () => {
    const key = `test-protected-backpressure-${Date.now()}`;
    const settings = createQueueSettings({ mode: "followup", cap: 1, dropPolicy: "summarize" });
    const dropped = vi.fn();
    const abandoned = vi.fn();
    const rejected = createQueueTestRun({ prompt: "rejected" });
    rejected.turnAdoptionLifecycle = {
      admission: "exclusive",
      onAdopted: vi.fn(),
      onDropped: dropped,
      onAbandoned: abandoned,
    };
    try {
      expect(
        enqueueFollowupRun(
          key,
          createQueueTestRun({ prompt: "protected", protectFromQueueOverflow: true }),
          settings,
        ),
      ).toBe(true);
      expect(enqueueFollowupRun(key, rejected, settings)).toBe(false);
      await rejected.controllerInput!.settlement.promise;
      expect(abandoned).toHaveBeenCalledOnce();
      expect(dropped).not.toHaveBeenCalled();
    } finally {
      clearFollowupQueue(key);
    }
  });
});

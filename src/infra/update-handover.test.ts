import { describe, expect, it, vi } from "vitest";
import { runUpdateHandover, type UpdateConfirmationTier } from "./update-handover.js";

function harness(params: {
  healthy?: boolean;
  tier?: UpdateConfirmationTier;
  confirmed?: boolean;
}) {
  const calls: string[] = [];
  const record = (name: string) => async () => {
    calls.push(name);
  };
  return {
    calls,
    run: () =>
      runUpdateHandover({
        confirmationTier: params.tier ?? "delivery",
        waitForInternalHealth: vi.fn(async () => params.healthy ?? true),
        pauseOldChannels: record("pause-old"),
        startNewChannels: record("start-new"),
        confirmDelivery: vi.fn(async () => params.confirmed ?? true),
        confirmHumanReply: vi.fn(async () => params.confirmed ?? true),
        stopNewChannels: record("stop-new"),
        restorePrevious: record("restore"),
        resumeOldChannels: record("resume-old"),
        onPhase: async (phase) => {
          calls.push(phase);
        },
      }),
  };
}

describe("update handover", () => {
  it("keeps channels exclusive through delivery-confirmed completion", async () => {
    const subject = harness({});
    expect((await subject.run()).phase).toBe("completed");
    expect(subject.calls).toEqual([
      "internal-healthy",
      "pause-old",
      "old-paused",
      "start-new",
      "new-active",
      "confirmed",
      "completed",
    ]);
  });

  it("rolls back and resumes old channels after a human-tier timeout", async () => {
    const subject = harness({ tier: "human", confirmed: false });
    expect((await subject.run()).phase).toBe("rolled-back");
    expect(subject.calls).toEqual([
      "internal-healthy",
      "pause-old",
      "old-paused",
      "start-new",
      "new-active",
      "rolling-back",
      "stop-new",
      "restore",
      "resume-old",
      "rolled-back",
    ]);
  });

  it("never pauses old channels when internal health fails", async () => {
    const subject = harness({ healthy: false });
    expect((await subject.run()).phase).toBe("rolled-back");
    expect(subject.calls).toEqual(["rolling-back", "restore", "rolled-back"]);
  });

  it("rolls back when delivery acknowledgement fails", async () => {
    const subject = harness({ confirmed: false });
    expect((await subject.run()).phase).toBe("rolled-back");
    expect(subject.calls.slice(-4)).toEqual(["stop-new", "restore", "resume-old", "rolled-back"]);
  });

  it("restores old channels before propagating a new-channel startup failure", async () => {
    const subject = harness({});
    subject.run = () =>
      runUpdateHandover({
        confirmationTier: "delivery",
        waitForInternalHealth: async () => true,
        pauseOldChannels: async () => {
          subject.calls.push("pause-old");
        },
        startNewChannels: async () => {
          subject.calls.push("start-new");
          throw new Error("new channel startup failed");
        },
        confirmDelivery: async () => true,
        confirmHumanReply: async () => true,
        stopNewChannels: async () => {
          subject.calls.push("stop-new");
        },
        restorePrevious: async () => {
          subject.calls.push("restore");
        },
        resumeOldChannels: async () => {
          subject.calls.push("resume-old");
        },
      });

    await expect(subject.run()).rejects.toThrow("Update handover failed after rollback");
    expect(subject.calls).toEqual(["pause-old", "start-new", "stop-new", "restore", "resume-old"]);
  });

  it("continues restoration when stopping new channels fails", async () => {
    const calls: string[] = [];
    await expect(
      runUpdateHandover({
        confirmationTier: "human",
        waitForInternalHealth: async () => true,
        pauseOldChannels: async () => {
          calls.push("pause-old");
        },
        startNewChannels: async () => {
          calls.push("start-new");
        },
        confirmDelivery: async () => true,
        confirmHumanReply: async () => false,
        stopNewChannels: async () => {
          calls.push("stop-new");
          throw new Error("stop failed");
        },
        restorePrevious: async () => {
          calls.push("restore");
        },
        resumeOldChannels: async () => {
          calls.push("resume-old");
        },
        onPhase: (phase) => {
          calls.push(phase);
        },
      }),
    ).rejects.toThrow("Update handover failed after rollback");
    expect(calls).not.toContain("rolled-back");
    expect(calls.slice(-3)).toEqual(["stop-new", "restore", "resume-old"]);
  });

  it("propagates an undefined rejection reason after compensation", async () => {
    const calls: string[] = [];
    await expect(
      runUpdateHandover({
        confirmationTier: "delivery",
        waitForInternalHealth: async () => true,
        pauseOldChannels: async () => {
          calls.push("pause-old");
        },
        startNewChannels: async () => await Promise.reject(),
        confirmDelivery: async () => true,
        confirmHumanReply: async () => true,
        stopNewChannels: async () => {
          calls.push("stop-new");
        },
        restorePrevious: async () => {
          calls.push("restore");
        },
        resumeOldChannels: async () => {
          calls.push("resume-old");
        },
      }),
    ).rejects.toThrow("Update handover failed after rollback");
    expect(calls).toEqual(["pause-old", "stop-new", "restore", "resume-old"]);
  });
});

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
    expect(subject.calls).toEqual([
      "rolling-back",
      "stop-new",
      "restore",
      "resume-old",
      "rolled-back",
    ]);
  });

  it("rolls back when delivery acknowledgement fails", async () => {
    const subject = harness({ confirmed: false });
    expect((await subject.run()).phase).toBe("rolled-back");
    expect(subject.calls.slice(-4)).toEqual(["stop-new", "restore", "resume-old", "rolled-back"]);
  });
});

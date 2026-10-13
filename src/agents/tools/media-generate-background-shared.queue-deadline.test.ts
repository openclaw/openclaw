import { afterEach, describe, expect, it, vi } from "vitest";
import { findMediaGenerationOperation } from "../media-generation-activity.js";
import {
  admitMediaHandle,
  resetGeneratedMediaTaskActivityForTests,
} from "../media-generation-activity.test-support.js";
import {
  createMediaGenerationTaskLifecycle,
  scheduleMediaGenerationTaskCompletion,
} from "./media-generate-background-shared.js";

describe("queue-owned media completion deadline", () => {
  afterEach(() => {
    vi.useRealTimers();
    resetGeneratedMediaTaskActivityForTests();
  });

  it("waits past the wake deadline and succeeds only after the handoff is delivered", async () => {
    vi.useFakeTimers();
    const onWakeFailure = vi.fn();
    const scheduled: Array<() => Promise<void>> = [];
    let phase: "pending" | "delivered" = "pending";
    const lifecycle = createMediaGenerationTaskLifecycle("image");
    const wake = vi
      .spyOn(lifecycle, "wakeTaskCompletion")
      .mockImplementation(async () =>
        phase === "pending" ? { status: "pending", queueOwned: true } : { status: "delivered" },
      );
    const handle = admitMediaHandle({
      taskId: "task-queue-owned",
      runId: "tool:image_generate:queue-owned",
      requesterSessionKey: "agent:main:discord:channel:queue-owned",
      taskLabel: "proof image",
    });
    scheduleMediaGenerationTaskCompletion({
      lifecycle,
      handle,
      scheduleBackgroundWork: (work) => {
        scheduled.push(work);
      },
      progressSummary: "Generating image",
      toolName: "Image generation",
      onWakeFailure,
      run: async () => ({ provider: "openai", model: "gpt-image-1", count: 1, wakeResult: "ok" }),
    });

    const background = scheduled[0]?.();
    await vi.advanceTimersByTimeAsync(120_000);
    const waiting = findMediaGenerationOperation(handle.runId);
    console.info(
      JSON.stringify({
        proof: "pending handoff past wake deadline",
        operationStatus: waiting?.status ?? null,
        endedAt: waiting?.endedAt ?? null,
        terminalOutcome: waiting?.terminalOutcome ?? null,
        wakeFailures: onWakeFailure.mock.calls.length,
        wakeCalls: wake.mock.calls.length,
      }),
    );
    expect(onWakeFailure).not.toHaveBeenCalled();
    expect(waiting?.status).toBe("running");
    expect(waiting?.endedAt).toBeUndefined();
    expect(waiting?.terminalOutcome).toBeUndefined();
    expect(wake.mock.calls.length).toBeGreaterThan(1);

    phase = "delivered";
    await vi.advanceTimersByTimeAsync(2_000);
    await background;
    const settled = findMediaGenerationOperation(handle.runId);
    console.info(
      JSON.stringify({
        proof: "handoff delivered after the deadline",
        operationStatus: settled?.status ?? null,
        terminalOutcome: settled?.terminalOutcome ?? null,
        wakeFailures: onWakeFailure.mock.calls.length,
      }),
    );
    expect(onWakeFailure).not.toHaveBeenCalled();
    expect(settled?.status).toBe("succeeded");
    expect(settled?.terminalOutcome).toBeUndefined();
  });

  it("does not mark a still-queued handoff successful when delivery never lands", async () => {
    vi.useFakeTimers();
    const onWakeFailure = vi.fn();
    const scheduled: Array<() => Promise<void>> = [];
    let landed = false;
    const lifecycle = createMediaGenerationTaskLifecycle("image");
    vi.spyOn(lifecycle, "wakeTaskCompletion").mockImplementation(async () =>
      landed ? { status: "permanent_failure" } : { status: "pending", queueOwned: true },
    );
    const handle = admitMediaHandle({
      taskId: "task-never-lands",
      runId: "tool:image_generate:never-lands",
      requesterSessionKey: "agent:main:discord:channel:never-lands",
      taskLabel: "proof image",
    });
    scheduleMediaGenerationTaskCompletion({
      lifecycle,
      handle,
      scheduleBackgroundWork: (work) => {
        scheduled.push(work);
      },
      progressSummary: "Generating image",
      toolName: "Image generation",
      onWakeFailure,
      run: async () => ({
        provider: "openai",
        model: "gpt-image-1",
        count: 1,
        wakeResult: "ok",
        attachments: [{ type: "image", path: "/tmp/proof.png" }],
        mediaUrls: ["/tmp/proof.png"],
      }),
    });

    const background = scheduled[0]?.();
    await vi.advanceTimersByTimeAsync(120_000);
    const waiting = findMediaGenerationOperation(handle.runId);
    console.info(
      JSON.stringify({
        proof: "media never landed at the wake deadline",
        operationStatus: waiting?.status ?? null,
        endedAt: waiting?.endedAt ?? null,
        terminalOutcome: waiting?.terminalOutcome ?? null,
        wakeFailures: onWakeFailure.mock.calls.length,
      }),
    );
    expect(waiting?.status).toBe("running");
    expect(waiting?.endedAt).toBeUndefined();
    expect(onWakeFailure).not.toHaveBeenCalled();

    landed = true;
    await vi.advanceTimersByTimeAsync(2_000);
    await background;
    const settled = findMediaGenerationOperation(handle.runId);
    console.info(
      JSON.stringify({
        proof: "permanent handoff failure after the deadline",
        operationStatus: settled?.status ?? null,
        terminalOutcome: settled?.terminalOutcome ?? null,
        wakeFailures: onWakeFailure.mock.calls.length,
      }),
    );
    expect(settled?.terminalOutcome).toBe("blocked");
    expect(settled?.status).not.toBe("running");
    expect(onWakeFailure).toHaveBeenCalled();
  });
});

import { expect, it, vi } from "vitest";
import {
  createChannelProgressDraftCompositor,
  PROGRESS_STATUS_PREAMBLE_FRESH_MS,
} from "./progress-draft-compositor.js";

function createTestProgressDraftCompositor(
  overrides: Omit<
    Parameters<typeof createChannelProgressDraftCompositor>[0],
    "mode" | "active" | "seed"
  >,
) {
  return createChannelProgressDraftCompositor({
    mode: "progress",
    active: true,
    seed: "test",
    ...overrides,
  });
}

it("keeps the preamble headline alongside the commentary lane when it is enabled", async () => {
  const update = vi.fn();
  const progress = createTestProgressDraftCompositor({
    entry: {
      streaming: {
        mode: "progress",
        progress: { label: false, commentary: true, toolProgress: true, maxLines: 1 },
      },
    },
    update,
  });

  await progress.pushToolProgress("🛠️ Setup", { startImmediately: true });
  update.mockClear();
  expect(
    await progress.pushItemEvent({
      kind: "preamble",
      phase: "end",
      progressText: "Reading the workspace.",
      itemId: "preamble-1",
    }),
  ).toBe(true);
  expect(update).toHaveBeenCalledTimes(1);
  expect(update.mock.lastCall?.[0]).toBe("Reading the workspace.\n\n_Reading the workspace._");
  expect(update.mock.lastCall?.[1].snapshot).toEqual({
    statusHeadline: "Reading the workspace.",
    lines: [expect.objectContaining({ id: "commentary:preamble-1", complete: true })],
  });

  update.mockClear();
  await progress.pushToolProgress("🛠️ Exec", { startImmediately: true });
  expect(update).toHaveBeenCalledTimes(1);
  expect(update.mock.lastCall?.[0]).toBe("Reading the workspace.\n\n🛠️ Exec");
});

it.each([false, true])(
  "retracts a paired preamble atomically with evicted history %s",
  async (evicted) => {
    const update = vi.fn();
    const deleteCurrent = vi.fn();
    const progress = createTestProgressDraftCompositor({
      entry: {
        streaming: {
          mode: "progress",
          progress: { label: false, commentary: true, toolProgress: true, maxLines: 1 },
        },
      },
      update,
      deleteCurrent,
    });
    await progress.pushItemEvent({
      kind: "preamble",
      phase: "end",
      itemId: "p1",
      progressText: "Reading the workspace.",
    });
    if (evicted) {
      await progress.pushToolProgress("🛠️ Exec", { startImmediately: true });
    }
    update.mockClear();

    await progress.pushItemEvent({ kind: "preamble", itemId: "p1", progressText: "" });

    expect(progress.hasStatusHeadline).toBe(false);
    if (evicted) {
      expect(update).toHaveBeenCalledExactlyOnceWith("🛠️ Exec", expect.anything());
      expect(deleteCurrent).not.toHaveBeenCalled();
    } else {
      expect(update).not.toHaveBeenCalled();
      expect(deleteCurrent).toHaveBeenCalledOnce();
      expect(progress.isVisible).toBe(false);
    }
  },
);

it("preserves the latest paired preamble across stale and unkeyed retractions", async () => {
  const update = vi.fn();
  const deleteCurrent = vi.fn();
  const progress = createTestProgressDraftCompositor({
    entry: {
      streaming: {
        mode: "progress",
        progress: { label: false, commentary: true, toolProgress: true, maxLines: 2 },
      },
    },
    update,
    deleteCurrent,
  });
  for (const itemId of ["first", "latest"]) {
    await progress.pushItemEvent({
      kind: "preamble",
      phase: "end",
      itemId,
      progressText: itemId,
    });
  }
  update.mockClear();
  await progress.pushItemEvent({ kind: "preamble", itemId: "first", progressText: "" });
  expect(update).toHaveBeenCalledExactlyOnceWith("latest\n\n_latest_", expect.anything());
  expect(progress.getSnapshot().statusHeadline).toBe("latest");

  const snapshot = progress.getSnapshot();
  update.mockClear();
  await progress.pushItemEvent({ kind: "preamble", progressText: "" });
  expect(progress.getSnapshot()).toEqual(snapshot);
  expect(update).not.toHaveBeenCalled();
  expect(deleteCurrent).not.toHaveBeenCalled();
});

it("publishes only complete preamble pairs and ignores them after final delivery starts", async () => {
  const update = vi.fn();
  const progress = createTestProgressDraftCompositor({
    entry: {
      streaming: {
        mode: "progress",
        progress: { label: false, commentary: true, toolProgress: true, maxLines: 1 },
      },
    },
    update,
  });
  await progress.pushItemEvent({
    kind: "preamble",
    phase: "end",
    itemId: "first",
    progressText: "First note",
  });
  const firstSnapshot = progress.getSnapshot();
  update.mockClear();
  for (const phase of ["start", "update"] as const) {
    await progress.pushItemEvent({
      kind: "preamble",
      phase,
      itemId: "next",
      progressText: "Next note",
    });
    expect(progress.getSnapshot()).toEqual(firstSnapshot);
    expect(update).not.toHaveBeenCalled();
  }
  await progress.pushItemEvent({
    kind: "preamble",
    phase: "end",
    itemId: "next",
    progressText: "Next note",
  });
  expect(update).toHaveBeenCalledExactlyOnceWith("Next note\n\n_Next note_", expect.anything());
  expect(progress.getSnapshot().lines).toEqual([expect.objectContaining({ complete: true })]);

  const finalSnapshot = progress.getSnapshot();
  progress.markFinalReplyStarted();
  update.mockClear();
  for (const progressText of ["Too late", ""]) {
    await progress.pushItemEvent({
      kind: "preamble",
      phase: "end",
      itemId: "next",
      progressText,
    });
    expect(progress.getSnapshot()).toEqual(finalSnapshot);
    expect(update).not.toHaveBeenCalled();
  }
});

it.each(["plan before preamble", "plan after preamble", "narration cleared with plan"] as const)(
  "refreshes a stale preamble to the retained explanation: %s",
  async (order) => {
    vi.useFakeTimers();
    const update = vi.fn();
    const progress = createTestProgressDraftCompositor({
      entry: {
        streaming: {
          mode: "progress",
          progress: { commentary: true, toolProgress: true, label: false, maxLines: 2 },
        },
      },
      update,
    });
    const explanation = "Applying the revised plan.";
    const pushPlan = () =>
      progress.pushPlanProgress([{ step: "Patch", status: "in_progress" }], { explanation });
    try {
      if (order !== "plan after preamble") {
        await pushPlan();
      }
      await progress.pushItemEvent({
        kind: "preamble",
        phase: "end",
        itemId: "p1",
        progressText: "Reading the workspace.",
      });
      if (order === "narration cleared with plan") {
        await progress.pushNarrationProgress("Comparing the configuration.");
      }
      await vi.advanceTimersByTimeAsync(5_000);
      if (order === "plan after preamble") {
        await pushPlan();
      } else if (order === "narration cleared with plan") {
        await progress.pushNarrationProgress("");
      }
      expect(update.mock.lastCall?.[1].snapshot.statusHeadline).toBe("Reading the workspace.");
      const history = progress.getSnapshot().lines;
      update.mockClear();

      await vi.advanceTimersByTimeAsync(PROGRESS_STATUS_PREAMBLE_FRESH_MS - 5_001);
      expect(update).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);

      expect(update).toHaveBeenCalledOnce();
      expect(update.mock.lastCall?.[1].snapshot).toEqual(
        expect.objectContaining({ statusHeadline: explanation, lines: history }),
      );
    } finally {
      progress.cancel();
      vi.useRealTimers();
    }
  },
);

it("hands the headline to narration and back without changing commentary history", async () => {
  vi.useFakeTimers();
  const update = vi.fn();
  const progress = createChannelProgressDraftCompositor({
    mode: "progress",
    active: true,
    seed: "test",
    entry: {
      streaming: {
        mode: "progress",
        progress: { commentary: true, toolProgress: true, label: false, maxLines: 2 },
      },
    },
    update,
  });
  const first = "Reading the workspace.";
  const narration = "Comparing the configuration now.";
  const next = "Preparing the focused fix.";
  try {
    await progress.start();
    await progress.pushItemEvent({
      kind: "preamble",
      phase: "end",
      itemId: "first",
      progressText: first,
    });
    await progress.pushNarrationProgress(narration);

    await vi.advanceTimersByTimeAsync(PROGRESS_STATUS_PREAMBLE_FRESH_MS - 1);
    expect(update.mock.lastCall?.[0]).toBe(`${first}\n\n_${first}_`);
    const history = progress.getSnapshot().lines;

    await vi.advanceTimersByTimeAsync(1);
    expect(update.mock.lastCall?.[0]).toBe(`${narration}\n\n_${first}_`);
    expect(progress.getSnapshot().lines).toEqual(history);

    await progress.pushItemEvent({
      kind: "preamble",
      phase: "end",
      itemId: "next",
      progressText: next,
    });
    expect(update.mock.lastCall?.[0]).toBe(`${next}\n\n_${first}_\n_${next}_`);

    await vi.advanceTimersByTimeAsync(PROGRESS_STATUS_PREAMBLE_FRESH_MS - 1);
    expect(update.mock.lastCall?.[0]).toBe(`${next}\n\n_${first}_\n_${next}_`);
    await vi.advanceTimersByTimeAsync(1);
    expect(update.mock.lastCall?.[0]).toBe(`${narration}\n\n_${first}_\n_${next}_`);

    await progress.pushToolProgress("Tool activity", { startImmediately: true });
    expect(update.mock.lastCall?.[0]).toBe(`${narration}\n\n_${next}_\n• Tool activity`);
    await progress.pushNarrationProgress("");
    expect(update.mock.lastCall?.[0]).toBe(`${next}\n\n_${next}_\n• Tool activity`);
  } finally {
    progress.cancel();
    vi.useRealTimers();
  }
});

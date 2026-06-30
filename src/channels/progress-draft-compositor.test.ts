// Progress draft compositor tests cover streamed draft composition for channel progress updates.
import { describe, expect, it, vi } from "vitest";
import { createChannelProgressDraftCompositor } from "./progress-draft-compositor.js";
import { DEFAULT_PROGRESS_DRAFT_INITIAL_DELAY_MS } from "./streaming.js";

describe("createChannelProgressDraftCompositor", () => {
  it("keeps the progress label visible when tool lines are hidden", async () => {
    const update = vi.fn();
    const progress = createChannelProgressDraftCompositor({
      entry: {
        streaming: { mode: "progress", progress: { label: "Shelling", toolProgress: false } },
      },
      mode: "progress",
      active: true,
      seed: "test",
      update,
    });

    await progress.pushToolProgress("🛠️ Exec", { startImmediately: true });

    expect(update).toHaveBeenCalledWith("Shelling", { flush: true, lines: [] });
  });

  it("arms the gate on answer activity but defers the first frame until a content line (tool-progress mode)", async () => {
    vi.useFakeTimers();
    try {
      const update = vi.fn();
      const progress = createChannelProgressDraftCompositor({
        entry: { streaming: { mode: "progress", progress: { label: "Shelling" } } },
        mode: "progress",
        active: true,
        seed: "test",
        update,
      });

      await progress.noteActivity();
      expect(update).not.toHaveBeenCalled();

      // The delayed-start timer fires during the silent window: the gate starts,
      // but a label-only draft is NOT delivered — in tool-progress mode the first
      // frame must carry a real tool/reasoning line, never a bare label.
      await vi.advanceTimersByTimeAsync(DEFAULT_PROGRESS_DRAFT_INITIAL_DELAY_MS);
      expect(progress.hasStarted).toBe(true);
      expect(update).not.toHaveBeenCalled();

      // The first content line is the first delivered frame, and it carries the tool line.
      const line = {
        kind: "tool" as const,
        text: "🛠️ Exec: git status",
        label: "Exec",
        icon: "🛠️",
        detail: "git status",
      };
      await progress.pushToolProgress(line);
      expect(update).toHaveBeenCalledTimes(1);
      expect(update).toHaveBeenCalledWith("Shelling\n\n🛠️ Exec: git status", {
        lines: [line],
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not materialize delayed answer activity after final delivery starts or lands", async () => {
    vi.useFakeTimers();
    try {
      for (const markFinal of ["markFinalReplyStarted", "markFinalReplyDelivered"] as const) {
        const update = vi.fn();
        const progress = createChannelProgressDraftCompositor({
          entry: { streaming: { mode: "progress", progress: { label: "Shelling" } } },
          mode: "progress",
          active: true,
          seed: "test",
          update,
        });

        await progress.noteActivity();
        progress[markFinal]();
        await vi.advanceTimersByTimeAsync(DEFAULT_PROGRESS_DRAFT_INITIAL_DELAY_MS);

        // The pre-final noteActivity armed the delayed-start gate, so its timer
        // may still fire and flip hasStarted — that flag is decoupled from
        // delivery. What must hold is that no draft is materialized once the
        // final reply has started/landed: the render path is blocked by the
        // final-reply guard, so update is never called.
        expect(update).not.toHaveBeenCalled();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not flash a bare label on repeated answer activity (tool-progress mode)", async () => {
    const update = vi.fn();
    const progress = createChannelProgressDraftCompositor({
      entry: { streaming: { mode: "progress", progress: { label: "Shelling" } } },
      mode: "progress",
      active: true,
      seed: "test",
      update,
    });

    await progress.noteActivity();
    await progress.noteActivity();

    // Two work events start the gate immediately, but with no tool/reasoning line
    // yet the compositor holds the frame instead of delivering a bare label.
    expect(progress.hasStarted).toBe(true);
    expect(update).not.toHaveBeenCalled();
  });

  it("gates window thinking on its own flag, independent of tool progress", async () => {
    // thinking: false hides thoughts even though toolProgress stays on…
    const hiddenUpdate = vi.fn();
    const hidden = createChannelProgressDraftCompositor({
      entry: {
        streaming: { mode: "progress", progress: { label: "Shelling" } },
      },
      mode: "progress",
      active: true,
      seed: "test",
      reasoningGate: false,
      update: hiddenUpdate,
    });
    await hidden.pushToolProgress("🛠️ Exec", { startImmediately: true });
    await hidden.pushReasoningProgress("Reading files");
    expect(hiddenUpdate.mock.calls.every(([text]) => !String(text).includes("Reading"))).toBe(true);

    const defaultUpdate = vi.fn();
    const sharedDefault = createChannelProgressDraftCompositor({
      entry: {
        streaming: {
          mode: "progress",
          progress: { label: "Shelling", toolProgress: false },
        },
      },
      mode: "progress",
      active: true,
      seed: "test",
      update: defaultUpdate,
    });
    await sharedDefault.pushToolProgress("🛠️ Exec", { startImmediately: true });
    await sharedDefault.pushReasoningProgress("Reading files");
    expect(defaultUpdate.mock.calls.every(([text]) => !String(text).includes("Reading"))).toBe(
      true,
    );

    const update = vi.fn();
    const progress = createChannelProgressDraftCompositor({
      entry: {
        streaming: {
          mode: "progress",
          progress: { label: "Shelling", toolProgress: false },
        },
      },
      mode: "progress",
      active: true,
      seed: "test",
      reasoningLinePrefix: "🧠 ",
      reasoningGate: true,
      update,
    });
    await progress.pushToolProgress("🛠️ Exec", { startImmediately: true });
    await progress.pushReasoningProgress("Reading files");
    expect(update).toHaveBeenLastCalledWith("Shelling\n\n🧠 _Reading files_", {
      lines: ["🧠 _Reading files_"],
    });
  });

  it("re-arms the draft for a queued turn after the primary final settled", async () => {
    const update = vi.fn();
    const progress = createChannelProgressDraftCompositor({
      entry: { streaming: { mode: "progress", progress: { label: "Shelling" } } },
      mode: "progress",
      active: true,
      seed: "test",
      update,
    });

    progress.markFinalReplyStarted();
    progress.markFinalReplyDelivered();
    expect(await progress.pushReasoningProgress("queued-turn thinking")).toBe(false);

    // New assistant message boundary on a queued/followup turn.
    progress.beginNewTurn();
    await progress.start();
    await progress.pushReasoningProgress("queued-turn thinking", { snapshot: true });

    expect(update).toHaveBeenCalled();
  });

  it("does not resurrect progress after suppression", async () => {
    const update = vi.fn();
    const progress = createChannelProgressDraftCompositor({
      entry: { streaming: { mode: "progress", progress: { label: "Shelling" } } },
      mode: "progress",
      active: true,
      seed: "test",
      update,
    });

    progress.suppress();
    await progress.pushReasoningProgress("Reading files");

    expect(update).not.toHaveBeenCalled();
  });

  it("composes reasoning deltas with tool progress", async () => {
    const update = vi.fn();
    const progress = createChannelProgressDraftCompositor({
      entry: { streaming: { mode: "progress", progress: { label: "Shelling" } } },
      mode: "progress",
      active: true,
      seed: "test",
      reasoningLinePrefix: "🧠 ",
      update,
    });

    await progress.pushToolProgress("🛠️ Exec", { startImmediately: true });
    await progress.pushReasoningProgress("Reading");
    await progress.pushReasoningProgress(" files");

    expect(update).toHaveBeenLastCalledWith("Shelling\n\n🛠️ Exec\n🧠 _Reading files_", {
      lines: ["🛠️ Exec", "🧠 _Reading files_"],
    });
  });

  it("labels window narration with a 💬 prefix", async () => {
    const update = vi.fn();
    const progress = createChannelProgressDraftCompositor({
      entry: { streaming: { mode: "progress", progress: { label: "Shelling", commentary: true } } },
      mode: "progress",
      active: true,
      seed: "test",
      commentaryLinePrefix: "💬 ",
      update,
    });

    await progress.pushCommentaryProgress("Checking the workspace", { itemId: "c1" });

    const rendered = update.mock.calls.map((call) => call[0]);
    expect(rendered).toContain("Shelling\n\n💬 _Checking the workspace_");
  });

  it("interleaves reasoning bursts with tool calls in arrival order", async () => {
    const update = vi.fn();
    const progress = createChannelProgressDraftCompositor({
      entry: {
        streaming: { mode: "progress", progress: { label: "Shelling", maxLines: 8 } },
      },
      mode: "progress",
      active: true,
      seed: "test",
      reasoningLinePrefix: "🧠 ",
      update,
    });

    // thought1 → tool1 → thought2 → tool2: each thought is its own line,
    // appended in order, not collapsed into a single replaced line.
    await progress.pushReasoningProgress("Listing the workspace");
    await progress.pushToolProgress("🛠️ ls", { startImmediately: true });
    await progress.pushReasoningProgress("Picking the largest");
    await progress.pushToolProgress("🛠️ wc", { startImmediately: true });

    expect(update).toHaveBeenLastCalledWith(
      "Shelling\n\n🧠 _Listing the workspace_\n🛠️ ls\n🧠 _Picking the largest_\n🛠️ wc",
      {
        lines: ["🧠 _Listing the workspace_", "🛠️ ls", "🧠 _Picking the largest_", "🛠️ wc"],
      },
    );
  });

  it("preserves tagged reasoning content without leaking tags", async () => {
    const update = vi.fn();
    const progress = createChannelProgressDraftCompositor({
      entry: { streaming: { mode: "progress", progress: { label: "Shelling" } } },
      mode: "progress",
      active: true,
      seed: "test",
      reasoningLinePrefix: "🧠 ",
      update,
    });

    await progress.pushToolProgress("🛠️ Exec", { startImmediately: true });
    await progress.pushReasoningProgress("<think>Checking files</think>Final answer prose");

    expect(update).toHaveBeenLastCalledWith("Shelling\n\n🛠️ Exec\n🧠 _Checking files_", {
      lines: ["🛠️ Exec", "🧠 _Checking files_"],
    });
  });

  it("waits for complete reasoning tags before showing tagged progress", async () => {
    const update = vi.fn();
    const progress = createChannelProgressDraftCompositor({
      entry: { streaming: { mode: "progress", progress: { label: "Shelling" } } },
      mode: "progress",
      active: true,
      seed: "test",
      update,
    });

    await progress.pushToolProgress("🛠️ Exec", { startImmediately: true });
    const calls = update.mock.calls.length;
    await progress.pushReasoningProgress("<thin");

    expect(update.mock.calls).toHaveLength(calls);
  });

  it("preserves partial reasoning tag buffers across deltas", async () => {
    const update = vi.fn();
    const progress = createChannelProgressDraftCompositor({
      entry: { streaming: { mode: "progress", progress: { label: "Shelling" } } },
      mode: "progress",
      active: true,
      seed: "test",
      reasoningLinePrefix: "🧠 ",
      update,
    });

    await progress.pushToolProgress("🛠️ Exec", { startImmediately: true });
    await progress.pushReasoningProgress("<thin");
    await progress.pushReasoningProgress("k>Checking files</think>Final answer prose");

    expect(update).toHaveBeenLastCalledWith("Shelling\n\n🛠️ Exec\n🧠 _Checking files_", {
      lines: ["🛠️ Exec", "🧠 _Checking files_"],
    });
  });

  it("keeps literal reasoning tags inside code blocks", async () => {
    const update = vi.fn();
    const progress = createChannelProgressDraftCompositor({
      entry: { streaming: { mode: "progress", progress: { label: "Shelling" } } },
      mode: "progress",
      active: true,
      seed: "test",
      reasoningLinePrefix: "🧠 ",
      update,
    });

    await progress.pushToolProgress("🛠️ Exec", { startImmediately: true });
    await progress.pushReasoningProgress("```html\n<think>literal</think>\n```");

    expect(update).toHaveBeenLastCalledWith(
      "Shelling\n\n🛠️ Exec\n🧠 _```html <think>literal</think> ```_",
      {
        lines: ["🛠️ Exec", "🧠 _```html <think>literal</think> ```_"],
      },
    );
  });

  it("replaces repeated formatted reasoning snapshots", async () => {
    const update = vi.fn();
    const progress = createChannelProgressDraftCompositor({
      entry: { streaming: { mode: "progress", progress: { label: "Shelling" } } },
      mode: "progress",
      active: true,
      seed: "test",
      reasoningLinePrefix: "🧠 ",
      update,
    });

    await progress.pushToolProgress("🛠️ Exec", { startImmediately: true });
    await progress.pushReasoningProgress("Thinking\n\n_Reading_");
    await progress.pushReasoningProgress("Thinking\n\n_Reading files_");

    expect(update).toHaveBeenLastCalledWith("Shelling\n\n🛠️ Exec\n🧠 _Reading files_", {
      lines: ["🛠️ Exec", "🧠 _Reading files_"],
    });
  });

  it("logs a timer-fired start failure via the gate's default boundary logger", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const error = new Error("send failed");
      const update = vi.fn().mockRejectedValue(error);
      const progress = createChannelProgressDraftCompositor({
        entry: { streaming: { mode: "progress", progress: { label: "Shelling" } } },
        mode: "progress",
        active: true,
        seed: "test",
        update,
      });

      await progress.pushToolProgress("🛠️ Exec");
      expect(warn).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(DEFAULT_PROGRESS_DRAFT_INITIAL_DELAY_MS);

      expect(update).toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(
        "[progress-draft] channel progress draft failed to start: Error: send failed",
      );
    } finally {
      vi.useRealTimers();
      warn.mockRestore();
    }
  });
});

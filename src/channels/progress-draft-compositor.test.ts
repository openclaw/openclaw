import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { ChannelStreamingProgressConfig } from "../config/types.base.js";
import { projectAgentToolActivity } from "../infra/agent-activity-events.js";
import {
  createChannelProgressDraftCompositor,
  createChannelProgressWorkCounter,
  PROGRESS_STATUS_PREAMBLE_FRESH_MS,
} from "./progress-draft-compositor.js";
import type { ChannelProgressDraftCompositorParams } from "./progress-draft-compositor.types.js";

function createProgress(
  config: ChannelStreamingProgressConfig = { label: "Shelling", toolProgress: true },
  overrides: Partial<ChannelProgressDraftCompositorParams> = {},
) {
  const update = vi.fn<NonNullable<ChannelProgressDraftCompositorParams["update"]>>();
  const progress = createChannelProgressDraftCompositor({
    active: true,
    mode: "progress",
    seed: "test",
    entry: { streaming: { mode: overrides.mode ?? "progress", progress: config } },
    update,
    ...overrides,
  });
  onTestFinished(() => progress.cancel());
  return { progress, update };
}

const plan = [
  { step: "Inspect", status: "completed" },
  { step: "Repair", status: "in_progress" },
  { step: "Verify", status: "pending" },
] satisfies Parameters<
  ReturnType<typeof createChannelProgressDraftCompositor>["pushPlanProgress"]
>[0];
const INITIAL_DELAY_MS = 1_500;

describe("channel progress draft compositor", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("counts only work tools and resets per turn", () => {
    let now = 1_000;
    const work = createChannelProgressWorkCounter({ now: () => now });
    work.noteToolCall("exec");
    work.noteToolCall("progress_card");
    now = 43_000;
    expect(work.toolCalls).toBe(1);
    expect(work.elapsedSeconds).toBe(42);
    work.reset();
    now = 43_500;
    expect(work.toolCalls).toBe(0);
    expect(work.elapsedSeconds).toBe(1);
  });

  it("gates reasoning independently of tool progress", async () => {
    const hidden = createProgress(undefined, { reasoningGate: false });
    await hidden.progress.pushToolProgress("🛠️ Exec", { startImmediately: true });
    await hidden.progress.pushReasoningProgress("Reading files");
    expect(hidden.update.mock.calls.every(([text]) => !text.includes("Reading"))).toBe(true);
    const quiet = createProgress({ label: "Shelling", toolProgress: false });
    await quiet.progress.pushToolProgress("🛠️ Exec", { startImmediately: true });
    await quiet.progress.pushReasoningProgress("Reading files");
    expect(quiet.update.mock.lastCall?.[0]).toBe("Shelling\n\n• _Reading files_");
    expect(quiet.update.mock.calls.every(([text]) => !text.includes("Exec"))).toBe(true);
  });

  it("shares reasoning merge state with inactive preview renderers", () => {
    const { progress } = createProgress({}, { mode: "partial", active: false });
    expect(progress.mergeReasoningProgress("Reading")).toBe("Reading");
    expect(progress.mergeReasoningProgress(" the Slack handler")).toBe("Reading the Slack handler");
    progress.resetReasoningProgress();
    expect(progress.mergeReasoningProgress("Checking again")).toBe("Checking again");
  });

  it("cancels delayed startup before final delivery", async () => {
    const { progress, update } = createProgress();
    await progress.pushToolProgress("🛠️ Exec");
    progress.markFinalReplyStarted();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
    expect(progress.hasStarted).toBe(false);
    expect(update).not.toHaveBeenCalled();
  });

  it("does not resurrect suppressed progress", async () => {
    const { progress, update } = createProgress();
    progress.suppress();
    await progress.pushReasoningProgress("Reading files");
    expect(update).not.toHaveBeenCalled();
  });

  it("publishes completion metadata when the final commentary delta has identical text", async () => {
    const { progress, update } = createProgress(
      { toolProgress: false, label: false, commentary: true, maxLines: 1 },
      { updateOnLineChange: true },
    );
    await progress.pushCommentaryProgress("Checking releases", { itemId: "p1", complete: false });
    expect(progress.getSnapshot().lines).toEqual([expect.objectContaining({ complete: false })]);
    update.mockClear();
    await progress.pushCommentaryProgress("Checking releases", { itemId: "p1", complete: true });
    expect(update).toHaveBeenCalledOnce();
    expect(update).toHaveBeenLastCalledWith(
      "_Checking releases_",
      expect.objectContaining({ lines: [expect.objectContaining({ complete: true })] }),
    );
  });

  it("updates cumulative id-less commentary in place across tools and ignores silent snapshots", async () => {
    const { progress, update } = createProgress(
      { toolProgress: true, label: "Shelling", commentary: true },
      { commentaryLinePrefix: "💬 " },
    );
    expect(await progress.pushPreambleHeadline("Checking")).toBe(false);
    expect(progress.hasStatusHeadline).toBe(false);
    await progress.pushCommentaryProgress("Checking");
    await progress.pushToolProgress("🛠️ Exec", { startImmediately: true });
    await progress.pushCommentaryProgress("Checking the workspace");
    expect(update.mock.lastCall?.[0]).toBe("Shelling\n\n💬 _Checking the workspace_\n🛠️ Exec");
    expect(progress.getSnapshot().lines).toEqual([
      expect.objectContaining({ text: "💬 _Checking the workspace_" }),
      "🛠️ Exec",
    ]);
    const calls = update.mock.calls.length;
    expect(
      await progress.pushCommentaryProgress("[[reply_to_current]] _NO_REPLY_ [[audio_as_voice]]"),
    ).toBe(false);
    expect(update).toHaveBeenCalledTimes(calls);
    await progress.pushCommentaryProgress("Writing the patch next");
    expect(progress.getSnapshot().lines).toHaveLength(3);
    expect(update.mock.lastCall?.[0]).toBe(
      "Shelling\n\n💬 _Checking the workspace_\n🛠️ Exec\n💬 _Writing the patch next_",
    );
  });

  it("replaces and retracts only the addressed commentary item", async () => {
    const { progress, update } = createProgress({
      label: false,
      commentary: true,
      toolProgress: true,
    });
    await progress.pushCommentaryProgress("First note", { itemId: "c1" });
    await progress.pushCommentaryProgress("Updated note", { itemId: "c1" });
    await progress.pushCommentaryProgress("Other note", { itemId: "c2" });
    expect(progress.getSnapshot().lines).toEqual([
      expect.objectContaining({ id: "commentary:c1", text: "_Updated note_" }),
      expect.objectContaining({ id: "commentary:c2", text: "_Other note_" }),
    ]);
    expect(await progress.pushCommentaryProgress("", { itemId: "c1" })).toBe(false);
    expect(update.mock.lastCall?.[0]).toBe("_Other note_");
    expect(progress.getSnapshot().lines).toHaveLength(1);
  });

  it("merges reasoning deltas within a burst and separates bursts across tools", async () => {
    const { progress, update } = createProgress(
      { label: "Shelling", toolProgress: true, maxLines: 8 },
      { reasoningLinePrefix: "🧠 " },
    );
    await progress.pushReasoningProgress("Listing");
    await progress.pushReasoningProgress(" the workspace");
    await progress.pushToolProgress("🛠️ ls", { startImmediately: true });
    await progress.pushReasoningProgress("Picking the largest");
    await progress.pushToolProgress("🛠️ wc", { startImmediately: true });
    expect(update.mock.lastCall?.[0]).toBe(
      "Shelling\n\n🧠 _Listing the workspace_\n🛠️ ls\n🧠 _Picking the largest_\n🛠️ wc",
    );
    expect(progress.getSnapshot().lines).toEqual([
      "🧠 _Listing the workspace_",
      "🛠️ ls",
      "🧠 _Picking the largest_",
      "🛠️ wc",
    ]);
  });

  it("buffers partial reasoning tags without leaking final answer prose", async () => {
    const { progress, update } = createProgress(undefined, { reasoningLinePrefix: "🧠 " });
    await progress.pushToolProgress("🛠️ Exec", { startImmediately: true });
    const calls = update.mock.calls.length;
    await progress.pushReasoningProgress("<thin");
    expect(update).toHaveBeenCalledTimes(calls);
    await progress.pushReasoningProgress("k>Checking files</think>Final answer prose");
    expect(update.mock.lastCall?.[0]).toBe("Shelling\n\n🛠️ Exec\n🧠 _Checking files_");
  });

  it("keeps literal reasoning tags inside code blocks", async () => {
    const { progress, update } = createProgress(undefined, { reasoningLinePrefix: "🧠 " });
    await progress.pushToolProgress("🛠️ Exec", { startImmediately: true });
    await progress.pushReasoningProgress("```html\n<think>literal</think>\n```");
    expect(update.mock.lastCall?.[0]).toBe(
      "Shelling\n\n🛠️ Exec\n🧠 _```html <think>literal</think> ```_",
    );
  });

  it("replaces repeated formatted reasoning snapshots", async () => {
    const { progress, update } = createProgress(undefined, { reasoningLinePrefix: "🧠 " });
    await progress.pushToolProgress("🛠️ Exec", { startImmediately: true });
    await progress.pushReasoningProgress("Thinking\n\n_Reading_");
    await progress.pushReasoningProgress("Thinking\n\n_Reading files_");
    expect(update.mock.lastCall?.[0]).toBe("Shelling\n\n🛠️ Exec\n🧠 _Reading files_");
  });

  it("keeps tool lines under narration while deduplicating and clearing the headline", async () => {
    const { progress, update } = createProgress();
    await progress.pushToolProgress("🛠️ Exec", { startImmediately: true });
    await progress.pushNarrationProgress("Updating config");
    expect(update.mock.lastCall?.[0]).toBe("Shelling\n\nUpdating config\n\n🛠️ Exec");
    await progress.pushToolProgress("🛠️ Wc", { startImmediately: true });
    expect(update.mock.lastCall?.[0]).toBe("Shelling\n\nUpdating config\n\n🛠️ Exec\n🛠️ Wc");
    expect(await progress.pushNarrationProgress("Updating config")).toBe(false);
    await progress.pushNarrationProgress("Restarting");
    expect(update.mock.lastCall?.[0]).toBe("Shelling\n\nRestarting\n\n🛠️ Exec\n🛠️ Wc");
    await progress.pushNarrationProgress("");
    expect(update.mock.lastCall?.[0]).toBe("Shelling\n\n🛠️ Exec\n🛠️ Wc");
  });

  it("holds sanitized preambles behind startup and rejects control-only replacements", async () => {
    const { progress, update } = createProgress({ toolProgress: true });
    expect(await progress.pushPreambleHeadline("[[reply_to_current]]")).toBe(false);
    expect(progress.hasStatusHeadline).toBe(false);
    await progress.pushPreambleHeadline(
      "[[reply_to_current]] Reading   the workspace. [[audio_as_voice]]",
    );
    expect(progress.hasStatusHeadline).toBe(true);
    expect(progress.hasStarted).toBe(false);
    expect(update).not.toHaveBeenCalled();
    await progress.start();
    expect(update.mock.lastCall?.[0]).toBe("Reading the workspace.");
    await vi.advanceTimersByTimeAsync(PROGRESS_STATUS_PREAMBLE_FRESH_MS);
    const calls = update.mock.calls.length;
    expect(await progress.pushPreambleHeadline("[[reply_to_current]]")).toBe(false);
    expect(
      await progress.pushPreambleHeadline("[[reply_to_current]] ~~NO_REPLY~~ [[audio_as_voice]]"),
    ).toBe(false);
    expect(progress.hasStatusHeadline).toBe(true);
    expect(update).toHaveBeenCalledTimes(calls);
    await progress.pushNarrationProgress("Utility filler.");
    expect(update.mock.lastCall?.[0]).toBe("Utility filler.");
    await progress.pushNarrationProgress("");
    expect(update.mock.lastCall?.[0]).toBe("Reading the workspace.");
  });

  it("retracts only the matching preamble headline", async () => {
    const deleteCurrent = vi.fn();
    const { progress, update } = createProgress(undefined, { deleteCurrent });
    await progress.start();
    await progress.pushPreambleHeadline("Reading", { itemId: "p1" });
    await progress.pushPreambleHeadline("Checking", { itemId: "p2" });
    const calls = update.mock.calls.length;
    expect(await progress.pushPreambleHeadline("", { itemId: "p1" })).toBe(false);
    expect(update).toHaveBeenCalledTimes(calls);
    expect(progress.hasStatusHeadline).toBe(true);
    expect(await progress.pushPreambleHeadline("", { itemId: "p2" })).toBe(true);
    expect(progress.hasStatusHeadline).toBe(false);
    expect(deleteCurrent).toHaveBeenCalledOnce();
    expect(progress.isVisible).toBe(false);
  });

  it("uses a plan explanation after the preamble becomes stale", async () => {
    const { progress, update } = createProgress();
    await progress.start();
    await progress.pushPreambleHeadline("Reading");
    await vi.advanceTimersByTimeAsync(PROGRESS_STATUS_PREAMBLE_FRESH_MS);
    await progress.pushPlanProgress([{ step: "Patch", status: "in_progress" }], {
      explanation: "Applying the plan",
    });
    expect(update.mock.lastCall?.[0]).toBe("Shelling\n\nApplying the plan\n\n▸ Patch");
  });

  it("refreshes a new preamble item even when it repeats the stale text", async () => {
    const { progress, update } = createProgress();
    await progress.start();
    await progress.pushPreambleHeadline("Reading", { itemId: "first" });
    await vi.advanceTimersByTimeAsync(PROGRESS_STATUS_PREAMBLE_FRESH_MS);
    await progress.pushNarrationProgress("Comparing");
    expect(update.mock.lastCall?.[0]).toBe("Shelling\n\nComparing");
    await progress.pushPreambleHeadline("Reading", { itemId: "second" });
    expect(update.mock.lastCall?.[0]).toBe("Shelling\n\nReading");
  });

  it("refreshes to retained narration when the preamble expires", async () => {
    const { progress, update } = createProgress();
    await progress.start();
    await progress.pushPreambleHeadline("Reading");
    await progress.pushNarrationProgress("Comparing");
    await vi.advanceTimersByTimeAsync(PROGRESS_STATUS_PREAMBLE_FRESH_MS - 1);
    expect(update.mock.lastCall?.[0]).toBe("Shelling\n\nReading");
    await vi.advanceTimersByTimeAsync(1);
    expect(update.mock.lastCall?.[0]).toBe("Shelling\n\nComparing");
  });

  it("cancels expiry and ignores late status until a new turn", async () => {
    const { progress, update } = createProgress();
    await progress.start();
    expect(progress.isVisible).toBe(true);
    await progress.pushPreambleHeadline("Checking");
    await progress.pushNarrationProgress("Working");
    expect(vi.getTimerCount()).toBe(1);
    progress.markFinalReplyStarted();
    expect(vi.getTimerCount()).toBe(0);
    expect(progress.isVisible).toBe(false);
    expect(await progress.pushPreambleHeadline("Too late")).toBe(false);
    expect(await progress.pushNarrationProgress("Too late")).toBe(false);
    progress.markFinalReplyDelivered();
    expect(await progress.pushReasoningProgress("Too late")).toBe(false);
    expect(progress.beginNewTurn()).toBe(true);
    expect(progress.hasStarted).toBe(false);
    await progress.pushToolProgress("🛠️ Next", { startImmediately: true });
    expect(update.mock.lastCall?.[0]).toBe("Shelling\n\n🛠️ Next");
    expect(progress.beginNewTurn()).toBe(false);
  });

  it("holds narration behind the initial progress delay", async () => {
    const { progress, update } = createProgress({ toolProgress: true });
    await progress.pushToolProgress("🛠️ Exec");
    await progress.pushNarrationProgress("Reading config");
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS - 1);
    expect(update).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(update).toHaveBeenCalledWith(
      "Reading config\n\n🛠️ Exec",
      expect.objectContaining({ flush: true, lines: ["🛠️ Exec"] }),
    );
    expect(progress.isVisible).toBe(true);
  });

  it("renders prepared items without duplicating raw diagnostic events", async () => {
    const { progress } = createProgress({ toolProgress: true }, { preparedItems: true });
    await progress.start();
    await progress.pushToolEvent({
      itemId: "tool-1",
      name: "exec",
      phase: "start",
      args: { command: "pnpm test" },
      detailMode: "raw",
    });
    expect(progress.getSnapshot().lines).toEqual([]);
    await progress.pushItemEvent(
      projectAgentToolActivity({
        toolCallId: "tool-1",
        name: "exec",
        phase: "start",
        args: { command: "pnpm test" },
      }),
    );
    await progress.pushItemEvent({ itemId: "item-1", kind: "search", progressText: "found tests" });
    await progress.pushApprovalEvent({ phase: "requested", command: "pnpm test" });
    await progress.pushCommandOutputEvent({
      itemId: "command-1",
      phase: "end",
      name: "exec",
      exitCode: 0,
    });
    await progress.pushPatchEvent({
      itemId: "patch-1",
      phase: "end",
      modified: ["src/example.ts"],
    });
    await progress.pushItemEvent({
      itemId: "command-1",
      kind: "command",
      title: "Run tests",
      phase: "end",
      status: "completed",
    });
    await progress.pushItemEvent({
      itemId: "patch-1",
      kind: "patch",
      name: "apply_patch",
      title: "Edit example",
      phase: "end",
      status: "completed",
    });
    await progress.pushApprovalEvent({ phase: "resolved", command: "ignored" });
    await progress.pushApprovalEvent({ command: "ignored without phase" });
    await progress.pushCommandOutputEvent({ phase: "start", title: "ignored" });
    await progress.pushCommandOutputEvent({ title: "ignored without phase" });
    await progress.pushPatchEvent({ phase: "start", modified: ["ignored.ts"] });
    await progress.pushPatchEvent({ modified: ["ignored-without-phase.ts"] });
    expect(progress.getSnapshot().lines).toEqual([
      expect.objectContaining({ id: "tool:tool-1", toolName: "exec" }),
      expect.objectContaining({ id: "item-1", kind: "item", toolName: "web_search" }),
      expect.objectContaining({ kind: "approval", status: "requested" }),
      expect.objectContaining({ id: "command-1", status: "completed" }),
      expect.objectContaining({ id: "patch-1", toolName: "apply_patch" }),
    ]);
    expect(progress.getSnapshot().diffStat).toBeUndefined();
  });

  it("retains completed edits when clearing a quiet plan", async () => {
    const { progress, update } = createProgress(
      { toolProgress: false, label: false },
      { updateOnLineChange: true },
    );
    await progress.pushPlanProgress([{ step: "Stale plan", status: "in_progress" }]);
    await progress.pushToolEvent({
      toolCallId: "write-1",
      name: "write",
      phase: "start",
      args: { path: "src/example.ts", content: "one\ntwo" },
    });
    expect(progress.getSnapshot().diffStat).toBeUndefined();
    await progress.pushItemEvent({
      toolCallId: "write-1",
      kind: "tool",
      phase: "end",
      status: "completed",
    });
    expect(progress.getSnapshot().diffStat).toEqual({ files: 1, added: 2, removed: 0 });
    expect(await progress.pushPlanProgress([])).toBe(true);
    expect(update.mock.lastCall?.[0]).toContain("📝 1 files +2");
    expect(update.mock.lastCall?.[0]).not.toContain("Stale plan");
    expect(progress.getSnapshot().lines).toEqual([]);
  });

  it("logs timer-fired startup failures at the boundary", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const update = vi.fn().mockRejectedValue(new Error("send failed"));
    const { progress } = createProgress(undefined, { update });
    await progress.pushToolProgress("🛠️ Exec");
    expect(warn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
    expect(update).toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      "[progress-draft] channel progress draft failed to start: Error: send failed",
    );
  });

  it("passes unformatted prepared notes to native updates", async () => {
    const tryNativeUpdate = vi.fn(async () => true);
    const { progress } = createProgress({ label: false, toolProgress: true }, { tryNativeUpdate });
    await progress.pushPlanProgress([], {
      explanation: "Use **literal**.",
      explanationFormat: "plain",
    });
    await progress.pushToolProgress("Reading", { startImmediately: true });
    expect(tryNativeUpdate).toHaveBeenCalledWith(expect.stringContaining("Use **literal**."));
  });

  it("repaints identical text when authored Markdown replaces a prepared note", async () => {
    const { progress, update } = createProgress(
      { label: false, commentary: false },
      { formatPlainText: (text) => text },
    );
    await progress.pushPlanProgress([], { explanation: "**literal**", explanationFormat: "plain" });
    expect(progress.getSnapshot().statusHeadlineFormat).toBe("plain");
    await progress.pushPreambleHeadline("**literal**");
    expect(update).toHaveBeenCalledTimes(2);
    expect(progress.getSnapshot()).toMatchObject({
      statusHeadline: "**literal**",
      planExplanationFormat: "plain",
    });
    expect(progress.getSnapshot().statusHeadlineFormat).toBeUndefined();
  });

  it.each(["partial", "progress"] as const)(
    "retains plans across message boundaries but clears them per turn (%s)",
    async (mode) => {
      const { progress, update } = createProgress({ label: false, toolProgress: true }, { mode });
      const steps = [{ step: "Patch", status: "in_progress" as const }];
      await progress.pushPlanProgress(steps, { explanation: "0/1 complete" });
      await progress.pushToolProgress("Inspecting files", { startImmediately: true });
      progress.beginAssistantMessage();
      await progress.pushItemEvent({
        itemId: "blocked-card",
        kind: "tool",
        name: "progress_card",
        phase: "end",
        status: "blocked",
      });
      const lines = [
        "Inspecting files",
        expect.objectContaining({ id: "blocked-card", status: "blocked" }),
      ];
      expect(update).toHaveBeenLastCalledWith(
        expect.stringContaining("▸ Patch"),
        expect.objectContaining({
          snapshot: expect.objectContaining({
            plan: steps,
            planExplanation: "0/1 complete",
            lines,
          }),
        }),
      );
      progress.beginAssistantMessage();
      expect(await progress.pushPlanProgress([])).toBe(true);
      expect(progress.getSnapshot()).toEqual({ lines });
      await progress.pushPlanProgress(steps, { explanation: "0/1 complete" });
      progress.resetActivity({ suppressed: true });
      expect(await progress.pushToolProgress("Hidden")).toBe(false);
      progress.beginAssistantMessage();
      expect(await progress.pushToolProgress("Verifying files", { startImmediately: true })).toBe(
        true,
      );
      expect(update.mock.lastCall?.[0]).toBe("0/1 complete\n\n• Verifying files\n▸ Patch");
      expect(progress.beginNewTurn({ force: true })).toBe(true);
      expect(progress.getSnapshot()).toEqual({ lines: [] });
      await progress.pushPlanProgress(steps, { explanation: "0/1 complete" });
      progress.reset();
      expect(progress.getSnapshot()).toEqual({ lines: [] });
    },
  );

  it("deletes an empty card and recreates identical content", async () => {
    const deleteCurrent = vi.fn();
    const { progress, update } = createProgress({}, { deleteCurrent });
    expect(await progress.pushPlanProgress()).toBe(false);
    expect(update).not.toHaveBeenCalled();
    expect(deleteCurrent).not.toHaveBeenCalled();
    const steps = [{ step: "Patch", status: "in_progress" as const }];
    expect(await progress.pushPlanProgress(steps)).toBe(true);
    expect(await progress.pushPlanProgress([])).toBe(true);
    expect(deleteCurrent).toHaveBeenCalledOnce();
    expect(progress.isVisible).toBe(false);
    expect(progress.getSnapshot().lines).toEqual([]);
    expect(await progress.pushPlanProgress(steps)).toBe(true);
    expect(update).toHaveBeenCalledTimes(2);
    expect(update.mock.lastCall?.[0]).toContain("▸ Patch");
  });

  it.each([false, "Custom progress"] as const)(
    "replaces plans without deletion support (label %s)",
    async (label) => {
      const { progress, update } = createProgress({ label });
      await progress.pushPlanProgress([]);
      expect(update).not.toHaveBeenCalled();
      await progress.pushPlanProgress([{ step: "Patch", status: "in_progress" }]);
      expect(await progress.pushPlanProgress([])).toBe(label !== false);
      if (label !== false) {
        expect(update.mock.lastCall?.[0]).toBe(label);
      }
      await progress.pushPlanProgress([{ step: "Verify", status: "in_progress" }]);
      expect(update.mock.lastCall?.[0]).toContain("▸ Verify");
      expect(update.mock.lastCall?.[0]).not.toContain("Patch");
    },
  );

  it("returns detached structured state to native renderers", async () => {
    const { progress, update } = createProgress({ toolProgress: true, label: false });
    await progress.pushPreambleHeadline("Checking Slack.");
    await progress.pushToolProgress(
      { id: "call", kind: "tool", text: "🛠️ Exec", label: "Exec", toolName: "exec" },
      { startImmediately: true },
    );
    await progress.pushPlanProgress([{ step: "Patch", status: "in_progress" }], {
      explanation: "Applying the change.",
    });
    const snapshot = update.mock.lastCall?.[1].snapshot;
    const expected = {
      lines: [{ id: "call", kind: "tool", text: "🛠️ Exec", label: "Exec", toolName: "exec" }],
      statusHeadline: "Checking Slack.",
      plan: [{ step: "Patch", status: "in_progress" }],
      planExplanation: "Applying the change.",
    };
    expect(snapshot).toEqual(expected);
    const line = snapshot?.lines[0];
    if (!snapshot?.plan?.[0] || typeof line !== "object") {
      throw new Error("expected structured snapshot");
    }
    line.text = "mutated";
    snapshot.plan[0].step = "mutated";
    expect(progress.getSnapshot()).toEqual(expected);
  });

  it("preserves summary presentation for SDK callers", async () => {
    const { progress, update } = createProgress(
      { toolProgress: true },
      { presentation: "summary" },
    );
    await progress.pushItemEvent(
      projectAgentToolActivity({ name: "exec", toolCallId: "call-1", phase: "start" }),
    );
    await progress.noteActivity({ startImmediately: true });
    expect(update.mock.lastCall?.[0]).toBe("Working");
    await progress.pushReasoningProgress("Checking the result");
    expect(update.mock.lastCall?.[0]).toContain("Checking the result");
    await progress.pushPlanProgress([{ step: "Verify", status: "in_progress" }]);
    expect(update.mock.lastCall?.[0]).toContain("In progress: Verify");
  });

  it("lets named tool failures scroll out while preserving blocked work and the plan", async () => {
    const { progress, update } = createProgress({ toolProgress: true, maxLines: 5, label: false });
    await progress.pushPlanProgress(plan);
    for (let index = 0; index < 8; index++) {
      await progress.pushItemEvent(
        projectAgentToolActivity({
          name: "exec",
          toolCallId: `failed-${index}`,
          phase: "result",
          status: "failed",
        }),
      );
    }
    await progress.pushItemEvent({
      itemId: "failed-automations",
      kind: "tool",
      name: "automations",
      status: "failed",
    });
    await progress.pushItemEvent({
      itemId: "real-failure",
      kind: "tool",
      name: "read",
      status: "failed",
      progressText: "Read failed",
    });
    await progress.pushItemEvent({
      itemId: "blocked-read",
      kind: "tool",
      name: "read",
      status: "blocked",
      progressText: "Read blocked",
    });
    for (let index = 0; index < 8; index++) {
      await progress.pushToolEvent({ name: "read", toolCallId: `new-${index}`, phase: "start" });
    }
    const lines = progress.getSnapshot().lines;
    for (const id of ["tool:failed-0", "failed-automations", "real-failure"]) {
      expect(lines).not.toContainEqual(expect.objectContaining({ id }));
    }
    expect(lines).toContainEqual(expect.objectContaining({ id: "blocked-read" }));
    expect(update.mock.lastCall?.[0]).toContain("Repair");
    expect(update.mock.lastCall?.[0]).toContain("Read blocked");
  });

  it("ignores late approval resolution after final delivery takes over", async () => {
    const deleteCurrent = vi.fn();
    const { progress, update } = createProgress({ label: false }, { deleteCurrent });
    await progress.pushApprovalEvent({
      phase: "requested",
      approvalId: "approval",
      title: "Run checks",
    });
    progress.markFinalReplyStarted();
    update.mockClear();
    await progress.pushApprovalEvent({ phase: "resolved", approvalId: "approval" });
    expect(update).not.toHaveBeenCalled();
    expect(deleteCurrent).not.toHaveBeenCalled();
  });

  it.each([
    { toolProgress: true, maxLines: 1 },
    { toolProgress: false, maxLines: 3 },
  ])(
    "flushes and retains approval attention through a full plan and activity ($toolProgress, $maxLines)",
    async ({ toolProgress, maxLines }) => {
      const { progress, update } = createProgress({
        toolProgress,
        maxLines,
        commentary: true,
        label: false,
      });
      await progress.pushApprovalEvent({
        phase: "requested",
        approvalId: "approval",
        title: "Run checks",
      });
      expect(progress.hasStarted).toBe(true);
      expect(update.mock.lastCall?.[0]).toContain("Run checks");
      expect(update.mock.lastCall?.[1]).toMatchObject({ flush: true });
      await progress.pushPlanProgress(plan);
      for (let index = 0; index < 5; index++) {
        await progress.pushToolEvent({ name: "read", toolCallId: `call-${index}`, phase: "start" });
        await progress.pushCommentaryProgress(`Inspecting file ${index}`, {
          itemId: `comment-${index}`,
        });
        await progress.pushReasoningProgress(`Thinking ${index}`, { snapshot: true });
      }
      expect(update.mock.lastCall?.[0]).toContain("Run checks");
      expect(progress.getSnapshot().lines.length).toBeLessThanOrEqual(maxLines);
      expect(update.mock.lastCall?.[0].split("\n").filter(Boolean).length).toBeLessThanOrEqual(
        maxLines,
      );
      await progress.pushApprovalEvent({ phase: "resolved", approvalId: "approval" });
      expect(update.mock.lastCall?.[0]).not.toContain("Run checks");
    },
  );

  it.each([undefined, true])(
    "starts failed-command drafts only with tool progress enabled (%s)",
    async (toolProgress) => {
      const { progress, update } = createProgress({ toolProgress, maxLines: 3, label: false });
      await progress.pushItemEvent(
        projectAgentToolActivity({
          name: "exec",
          phase: "result",
          toolCallId: "failed-command",
          status: "failed",
        }),
      );
      expect(progress.hasStarted).toBe(toolProgress === true);
      if (toolProgress) {
        expect(update.mock.lastCall?.[0]).toContain("failed");
        expect(update.mock.lastCall?.[1]).toMatchObject({ flush: true });
      } else {
        expect(update).not.toHaveBeenCalled();
        expect(progress.getSnapshot().lines).toEqual([]);
      }
    },
  );

  it.each([
    { presentation: undefined, toolProgress: false, maxLines: 1 },
    { presentation: "summary" as const, toolProgress: true, maxLines: 3 },
  ])(
    "keeps failed commands out of quiet plans ($presentation)",
    async ({ presentation, toolProgress, maxLines }) => {
      const { progress, update } = createProgress(
        { toolProgress, maxLines, commentary: true, label: false },
        { presentation },
      );
      await progress.pushPlanProgress(plan);
      const planText = update.mock.lastCall?.[0];
      await progress.pushItemEvent(
        projectAgentToolActivity({
          name: "exec",
          phase: "result",
          toolCallId: "failed-command",
          status: "failed",
        }),
      );
      expect(update.mock.lastCall?.[0]).toBe(planText);
      expect(progress.getSnapshot().lines).toEqual([]);
      for (let index = 0; index < 5; index++) {
        await progress.pushToolEvent({ name: "read", toolCallId: `read-${index}`, phase: "start" });
        await progress.pushReasoningProgress(`Thinking ${index}`, { snapshot: true });
        expect(update.mock.lastCall?.[0]).not.toContain("failed");
        await progress.pushCommentaryProgress(`Inspecting file ${index}`, {
          itemId: `comment-${index}`,
        });
        expect(update.mock.lastCall?.[0]).not.toContain("failed");
      }
      expect(update.mock.lastCall?.[0].split("\n").filter(Boolean).length).toBeLessThanOrEqual(
        maxLines,
      );
      await progress.pushItemEvent(
        projectAgentToolActivity({
          name: "exec",
          phase: "result",
          toolCallId: "failed-command",
          status: "completed",
        }),
      );
      expect(update.mock.lastCall?.[0]).not.toContain("failed");
    },
  );

  it("flushes explicit errors and retains them through later activity", async () => {
    const { progress, update } = createProgress({
      toolProgress: true,
      maxLines: 3,
      commentary: true,
      label: false,
    });
    await progress.pushPlanProgress(plan);
    await progress.pushItemEvent({
      itemId: "attention",
      kind: "tool",
      name: "read",
      status: "error",
      progressText: "Check access",
    });
    expect(update.mock.lastCall?.[0]).toContain("Check access");
    expect(update.mock.lastCall?.[1]).toMatchObject({ flush: true });
    for (let index = 0; index < 5; index++) {
      await progress.pushToolEvent({ name: "read", toolCallId: `read-${index}`, phase: "start" });
      await progress.pushCommentaryProgress(`Inspecting file ${index}`, {
        itemId: `comment-${index}`,
      });
    }
    expect(update.mock.lastCall?.[0]).toContain("Check access");
    expect(update.mock.lastCall?.[0].split("\n").filter(Boolean).length).toBeLessThanOrEqual(3);
  });

  it("replaces completed work without collapsing the plan", async () => {
    const { progress, update } = createProgress({
      toolProgress: true,
      maxLines: 8,
      commentary: true,
      label: false,
    });
    await progress.pushPlanProgress([
      ...plan,
      { step: "Audit", status: "pending" },
      { step: "Ship", status: "pending" },
    ]);
    for (let index = 1; index <= 8; index++) {
      await progress.pushItemEvent(
        projectAgentToolActivity({
          name: "exec",
          phase: "result",
          toolCallId: `completed-${index}`,
          status: "completed",
        }),
      );
    }
    await progress.pushItemEvent(
      projectAgentToolActivity({ name: "read", toolCallId: "new-work", phase: "start" }),
    );
    for (const step of ["Inspect", "Repair", "Verify", "Audit", "Ship", "Read"]) {
      expect(update.mock.lastCall?.[0]).toContain(step);
    }
    expect(progress.getSnapshot().lines).not.toContainEqual(
      expect.objectContaining({ id: "tool:completed-1" }),
    );
    expect(progress.getSnapshot().lines).toHaveLength(8);
  });

  it("keeps rejected delayed updates pending and retryable", async () => {
    const update = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const { progress } = createProgress({ label: "Working", commentary: true }, { update });
    await progress.pushToolProgress("🛠️ Exec");
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
    expect(progress.isVisible).toBe(false);
    expect(await progress.pushToolProgress("🛠️ Exec")).toBe(true);
    expect(update).toHaveBeenCalledTimes(2);
    expect(progress.isVisible).toBe(true);
  });

  it("retries rejected explicit activity with a flush", async () => {
    const update = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const { progress } = createProgress({ label: "Working" }, { update });
    expect(await progress.noteActivity({ startImmediately: true })).toBe(false);
    expect(progress.isVisible).toBe(false);
    expect(await progress.noteActivity({ startImmediately: true })).toBe(true);
    expect(progress.isVisible).toBe(true);
    expect(update.mock.calls.map(([, options]) => options.flush)).toEqual([true, true]);
  });

  it("rejects pending startup acceptance after final delivery cancels it", async () => {
    const started = createDeferred();
    const accepted = createDeferred<boolean>();
    const { progress } = createProgress(undefined, {
      update: () => {
        started.resolve();
        return accepted.promise;
      },
    });
    const result = progress.pushToolProgress("🛠️ Exec", { startImmediately: true });
    await started.promise;
    progress.markFinalReplyStarted();
    accepted.resolve(true);
    expect(await result).toBe(false);
    expect(progress.hasStarted).toBe(false);
    expect(progress.isVisible).toBe(false);
  });
});

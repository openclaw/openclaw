import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { ChannelStreamingProgressConfig } from "../config/types.base.js";
import { projectAgentToolActivity } from "../infra/agent-activity-events.js";
import {
  createChannelProgressDraftCompositor,
  createChannelProgressWorkCounter,
  PROGRESS_STATUS_PREAMBLE_FRESH_MS,
} from "./progress-draft-compositor.js";
import type { ChannelProgressDraftCompositorParams } from "./progress-draft-compositor.types.js";
import { buildChannelProgressDraftLine } from "./streaming.js";

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
  return {
    progress,
    update,
    rendered: () => expect(update.mock.lastCall?.[0]),
    lines: () => expect(progress.getSnapshot().lines),
    toolItem: (
      itemId: string,
      name: string,
      phase: "start" | "end" | undefined,
      status: "running" | "completed",
      extra: Partial<Parameters<typeof progress.pushItemEvent>[0]> = {},
    ) => progress.pushItemEvent({ itemId, kind: "tool", name, phase, status, ...extra }),
    modelWait: (progressText?: string) =>
      progress.pushItemEvent({
        itemId: "model-wait",
        kind: "model-wait",
        phase: progressText ? "update" : "end",
        ...(progressText ? { progressText } : {}),
      }),
    item: (
      kind: string,
      itemId: string,
      fields: Partial<Parameters<typeof progress.pushItemEvent>[0]> = {},
    ) => progress.pushItemEvent({ kind, itemId, ...fields }),
    activity: (
      name: string,
      toolCallId: string,
      phase: "start" | "result",
      extra: Partial<Parameters<typeof projectAgentToolActivity>[0]> = {},
    ) => progress.pushItemEvent(projectAgentToolActivity({ name, toolCallId, phase, ...extra })),
  };
}

const plan = [
  { step: "Inspect", status: "completed" },
  { step: "Repair", status: "in_progress" },
  { step: "Verify", status: "pending" },
] satisfies Parameters<
  ReturnType<typeof createChannelProgressDraftCompositor>["pushPlanProgress"]
>[0];
const INITIAL_DELAY_MS = 1_500;
const quiet = { toolProgress: false, label: false } as const;
const commentary = { toolProgress: true, label: false, commentary: true } as const;
const approvalRequest = {
  phase: "requested",
  approvalId: "approval",
  title: "Run checks",
} as const;

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it.each(["NO_REPLY", "_NO_REPLY_", "no_reply"])(
  "forwards prepared literal commentary: %s",
  async (text) => {
    const { progress, rendered } = createProgress({
      toolProgress: false,
      label: false,
      commentary: true,
    });
    expect(await progress.pushCommentaryProgress(text)).toBe(true);
    rendered().toContain(text);
  },
);

it("keeps bounded operation state without a preamble or verbose tool log", async () => {
  const { progress, toolItem, update, rendered, lines } = createProgress(quiet, {
    preparedItems: true,
    showWorkStatus: true,
  });
  await toolItem("read-1", "read", "start", "running", {
    title: "Private document",
    meta: "private/path.txt",
  });
  expect(update).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
  rendered().toBe("Read: running");
  await toolItem("exec-2", "exec", "start", "running");
  await toolItem("read-1", "read", "end", "completed");
  rendered().toBe("Exec: running");
  lines().toHaveLength(1);
  expect(JSON.stringify(update.mock.calls)).not.toContain("private/path");
  await progress.pushItemEvent({ itemId: "exec-2", hideFromChannelProgress: true });
  lines().toHaveLength(0);
  progress.markFinalReplyStarted();
  const calls = update.mock.calls.length;
  await toolItem("late", "write", undefined, "running");
  await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
  expect(update).toHaveBeenCalledTimes(calls);
});

it("retracts model waits and restores the existing status without retaining a work item", async () => {
  const deleteCurrent = vi.fn();
  const { progress, modelWait, rendered, lines } = createProgress(quiet, {
    preparedItems: true,
    deleteCurrent,
  });
  await modelWait("Waiting for the local model to respond");
  rendered().toBe("Waiting for the local model to respond");
  lines().toHaveLength(0);
  await modelWait();
  expect(deleteCurrent).toHaveBeenCalledOnce();
  expect(progress.hasStatusHeadline).toBe(false);

  await progress.pushPreambleHeadline("Checking the result");
  await modelWait("Waiting for a free model slot");
  rendered().toBe("Waiting for a free model slot");
  await modelWait();
  rendered().toBe("Checking the result");
  lines().toHaveLength(0);
});

it.each(["cancel", "markFinalReplyStarted", "markFinalReplyDelivered"] as const)(
  "clears transient model wait on %s",
  async (terminal) => {
    const { progress, modelWait } = createProgress({ label: false });
    await modelWait("Waiting for the local model to respond");
    progress[terminal]();
    expect(progress.getText()).not.toContain("Waiting for");
  },
);

it("continues public child state with the detailed tool log disabled", async () => {
  const { progress, item, rendered, update } = createProgress(quiet, {
    preparedItems: true,
    showWorkStatus: true,
  });
  await progress.pushPreambleHeadline("Checking the result");
  await item("subagent", "child", {
    title: "Verification",
    status: "running",
    summary: "PRIVATE CHILD CONTENT",
  });
  await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
  rendered().toContain("Verification: running");
  rendered().toContain("Checking the result");
  await item("subagent", "child", {
    title: "Verification",
    phase: "end",
    status: "completed",
  });
  rendered().toContain("Verification: completed");
  expect(JSON.stringify(update.mock.calls)).not.toContain("PRIVATE CHILD CONTENT");
});

it("counts only work tools and resets per turn", () => {
  let now = 1_000;
  const work = createChannelProgressWorkCounter({ now: () => now });
  work.noteToolCall("exec");
  work.noteToolCall("progress_card");
  now = 43_000;
  expect(work).toMatchObject({ toolCalls: 1, elapsedSeconds: 42 });
  work.reset();
  now = 43_500;
  expect(work).toMatchObject({ toolCalls: 0, elapsedSeconds: 1 });
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
  await progress.pushToolProgress("Exec");
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
  const { progress, lines, update } = createProgress(
    { toolProgress: false, label: false, commentary: true, maxLines: 1 },
    { updateOnLineChange: true },
  );
  await progress.pushCommentaryProgress("Checking releases", { itemId: "p1", complete: false });
  lines().toEqual([expect.objectContaining({ complete: false })]);
  update.mockClear();
  await progress.pushCommentaryProgress("Checking releases", { itemId: "p1", complete: true });
  expect(update).toHaveBeenCalledOnce();
  expect(update).toHaveBeenLastCalledWith(
    "_Checking releases_",
    expect.objectContaining({ lines: [expect.objectContaining({ complete: true })] }),
  );
});

it("updates cumulative id-less commentary in place across tools and ignores directive-only snapshots", async () => {
  const { progress, rendered, lines, update } = createProgress(
    { toolProgress: true, label: "Shelling", commentary: true },
    { commentaryLinePrefix: "💬 " },
  );
  expect(await progress.pushPreambleHeadline("Checking")).toBe(false);
  expect(progress.hasStatusHeadline).toBe(false);
  await progress.pushCommentaryProgress("Checking");
  await progress.pushToolProgress("Exec", { startImmediately: true });
  await progress.pushCommentaryProgress("Checking the workspace");
  rendered().toBe("Shelling\n\n💬 _Checking the workspace_\n• Exec");
  lines().toEqual([expect.objectContaining({ text: "💬 _Checking the workspace_" }), "Exec"]);
  const calls = update.mock.calls.length;
  expect(await progress.pushCommentaryProgress("[[reply_to_current]] [[audio_as_voice]]")).toBe(
    false,
  );
  expect(update).toHaveBeenCalledTimes(calls);
  await progress.pushCommentaryProgress("Writing the patch next");
  lines().toHaveLength(3);
  rendered().toBe("Shelling\n\n💬 _Checking the workspace_\n• Exec\n💬 _Writing the patch next_");
});

it("prefixes generated tool rows with text glyphs", async () => {
  const { progress, toolItem, rendered } = createProgress(commentary, {
    toolIcons: true,
    commentaryLinePrefix: "💬 ",
    buildProgressEventLine: (input, options) => {
      const line = buildChannelProgressDraftLine(input, options);
      return line?.toolName === "read" ? { ...line, icon: "🧪" } : line;
    },
  });
  await progress.pushCommentaryProgress("Checking");
  await toolItem("exec-1", "exec", undefined, "running");
  await toolItem("read-1", "read", undefined, "running");
  await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
  rendered().toBe("💬 _Checking_\n🛠️ Exec: running\n🧪 Read: running");
});

it("replaces and retracts only the addressed commentary item", async () => {
  const { progress, rendered, lines } = createProgress(commentary);
  await progress.pushCommentaryProgress("First note", { itemId: "c1" });
  await progress.pushCommentaryProgress("Updated note", { itemId: "c1" });
  await progress.pushCommentaryProgress("Other note", { itemId: "c2" });
  lines().toEqual([
    expect.objectContaining({ id: "commentary:c1", text: "_Updated note_" }),
    expect.objectContaining({ id: "commentary:c2", text: "_Other note_" }),
  ]);
  expect(await progress.pushCommentaryProgress("", { itemId: "c1" })).toBe(false);
  rendered().toBe("_Other note_");
  lines().toHaveLength(1);
});

it("merges reasoning deltas within a burst and separates bursts across tools", async () => {
  const { progress, lines, rendered } = createProgress(
    { label: "Shelling", toolProgress: true, maxLines: 8 },
    { reasoningLinePrefix: "🧠 " },
  );
  await progress.pushReasoningProgress("Listing");
  await progress.pushReasoningProgress(" the workspace");
  await progress.pushToolProgress("ls", { startImmediately: true });
  await progress.pushReasoningProgress("Picking the largest");
  await progress.pushToolProgress("wc", { startImmediately: true });
  rendered().toBe("Shelling\n\n🧠 _Listing the workspace_\n• ls\n🧠 _Picking the largest_\n• wc");
  lines().toEqual(["🧠 _Listing the workspace_", "ls", "🧠 _Picking the largest_", "wc"]);
});

it.each([
  ["buffers tags", ["<thin", "k>Check</think>Answer"], "Check", true],
  ["literal code", ["```html\n<think>x</think>\n```"], "```html <think>x</think> ```", false],
  ["snapshots", ["Thinking\n\n_A_", "Thinking\n\n_AB_"], "AB", false],
] as const)("reasoning %s", async (_name, chunks, expected, firstIsBuffered) => {
  const { progress, update, rendered } = createProgress(undefined, {
    reasoningLinePrefix: "🧠 ",
  });
  await progress.pushToolProgress("Exec", { startImmediately: true });
  const calls = update.mock.calls.length;
  for (const [index, chunk] of chunks.entries()) {
    await progress.pushReasoningProgress(chunk);
    if (firstIsBuffered && index === 0) {
      expect(update).toHaveBeenCalledTimes(calls);
    }
  }
  rendered().toBe(`Shelling\n\n• Exec\n🧠 _${expected}_`);
});

it("keeps tool lines under narration while deduplicating and clearing the headline", async () => {
  const { progress, rendered } = createProgress();
  await progress.pushToolProgress("Exec", { startImmediately: true });
  await progress.pushNarrationProgress("Updating config");
  rendered().toBe("Shelling\n\nUpdating config\n\n• Exec");
  await progress.pushToolProgress("Wc", { startImmediately: true });
  rendered().toBe("Shelling\n\nUpdating config\n\n• Exec\n• Wc");
  expect(await progress.pushNarrationProgress("Updating config")).toBe(false);
  await progress.pushNarrationProgress("Restarting");
  rendered().toBe("Shelling\n\nRestarting\n\n• Exec\n• Wc");
  await progress.pushNarrationProgress("");
  rendered().toBe("Shelling\n\n• Exec\n• Wc");
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
  expect(progress).toMatchObject({ hasStatusHeadline: false, isVisible: false });
  expect(deleteCurrent).toHaveBeenCalledOnce();
});

it("uses a plan explanation after the preamble becomes stale", async () => {
  const { progress, rendered } = createProgress();
  await progress.start();
  await progress.pushPreambleHeadline("Reading");
  await vi.advanceTimersByTimeAsync(PROGRESS_STATUS_PREAMBLE_FRESH_MS);
  await progress.pushPlanProgress([{ step: "Patch", status: "in_progress" }], {
    explanation: "Applying the plan",
  });
  rendered().toBe("Shelling\n\nApplying the plan\n\n▸ Patch");
});

it("refreshes a new preamble item even when it repeats the stale text", async () => {
  const { progress, rendered } = createProgress();
  await progress.start();
  await progress.pushPreambleHeadline("Reading", { itemId: "first" });
  await vi.advanceTimersByTimeAsync(PROGRESS_STATUS_PREAMBLE_FRESH_MS);
  await progress.pushNarrationProgress("Comparing");
  rendered().toBe("Shelling\n\nComparing");
  await progress.pushPreambleHeadline("Reading", { itemId: "second" });
  rendered().toBe("Shelling\n\nReading");
});

it("refreshes to retained narration when the preamble expires", async () => {
  const { progress, rendered } = createProgress();
  await progress.start();
  await progress.pushPreambleHeadline("Reading");
  await progress.pushNarrationProgress("Comparing");
  await vi.advanceTimersByTimeAsync(PROGRESS_STATUS_PREAMBLE_FRESH_MS - 1);
  rendered().toBe("Shelling\n\nReading");
  await vi.advanceTimersByTimeAsync(1);
  rendered().toBe("Shelling\n\nComparing");
});

it("cancels expiry and ignores late status until a new turn", async () => {
  const { progress, rendered } = createProgress();
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
  await progress.pushToolProgress("Next", { startImmediately: true });
  rendered().toBe("Shelling\n\n• Next");
  expect(progress.beginNewTurn()).toBe(false);
});

it("holds narration behind the initial progress delay", async () => {
  const { progress, update } = createProgress({ toolProgress: true });
  await progress.pushToolProgress("Exec");
  await progress.pushNarrationProgress("Reading config");
  await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS - 1);
  expect(update).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(update).toHaveBeenCalledWith(
    "Reading config\n\n• Exec",
    expect.objectContaining({ flush: true, lines: ["Exec"] }),
  );
  expect(progress.isVisible).toBe(true);
});

it("renders prepared items without duplicating raw diagnostic events", async () => {
  const { progress, lines, activity, item } = createProgress(
    { toolProgress: true },
    { preparedItems: true },
  );
  await progress.start();
  await progress.pushToolEvent({
    itemId: "tool-1",
    name: "exec",
    phase: "start",
    args: { command: "pnpm test" },
    detailMode: "raw",
  });
  lines().toEqual([]);
  await activity("exec", "tool-1", "start", { args: { command: "pnpm test" } });
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
  await item("command", "command-1", {
    title: "Run tests",
    phase: "end",
    status: "completed",
  });
  await item("patch", "patch-1", {
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
  lines().toEqual([
    expect.objectContaining({ id: "tool:tool-1", toolName: "exec" }),
    expect.objectContaining({ id: "item-1", kind: "item", toolName: "web_search" }),
    expect.objectContaining({ kind: "approval", status: "requested" }),
    expect.objectContaining({ id: "command-1", status: "completed" }),
    expect.objectContaining({ id: "patch-1", toolName: "apply_patch" }),
  ]);
  expect(progress.getSnapshot().diffStat).toBeUndefined();
});

it("projects failed message reaction progress", async () => {
  const action = "react";
  const status = "failed";
  const { progress, activity, lines } = createProgress(
    { toolProgress: true },
    { preparedItems: true },
  );
  await progress.start();
  await activity("message", "message-1", "start", {
    args: { action, channel: "slack", target: "C000000001" },
  });
  lines().toEqual([]);
  await activity("message", "message-1", "result", {
    args: { action, channel: "slack", target: "C000000001" },
    status,
  });
  await activity("read", "read-1", "result", {
    args: { path: "README.md" },
    status: "completed",
  });
  lines().toEqual([
    expect.objectContaining({ id: "tool:message-1", toolName: "message" }),
    expect.objectContaining({ id: "tool:read-1", toolName: "read", status: "completed" }),
  ]);
});

it("retains completed edits when clearing a quiet plan", async () => {
  const { progress, rendered, lines } = createProgress(quiet, {
    updateOnLineChange: true,
  });
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
  rendered().toContain("📝 1 files +2");
  rendered().not.toContain("Stale plan");
  lines().toEqual([]);
});

it("logs timer-fired startup failures at the boundary", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const update = vi.fn().mockRejectedValue(new Error("send failed"));
  const { progress } = createProgress(undefined, { update });
  await progress.pushToolProgress("Exec");
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

it("retains plans across partial message boundaries but clears them per turn", async () => {
  const { progress, item, update, rendered } = createProgress(
    { label: false, toolProgress: true },
    { mode: "partial" },
  );
  const steps = [{ step: "Patch", status: "in_progress" as const }];
  await progress.pushPlanProgress(steps, { explanation: "0/1 complete" });
  await progress.pushToolProgress("Inspecting files", { startImmediately: true });
  progress.beginAssistantMessage();
  await item("tool", "blocked-card", {
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
  expect(await progress.pushToolProgress("Verifying files", { startImmediately: true })).toBe(true);
  rendered().toBe("0/1 complete\n\n• Verifying files\n▸ Patch");
  expect(progress.beginNewTurn({ force: true })).toBe(true);
  expect(progress.getSnapshot()).toEqual({ lines: [] });
  await progress.pushPlanProgress(steps, { explanation: "0/1 complete" });
  progress.reset();
  expect(progress.getSnapshot()).toEqual({ lines: [] });
});

it("preserves summary presentation for SDK callers", async () => {
  const { progress, activity, rendered } = createProgress(
    { toolProgress: true },
    { presentation: "summary" },
  );
  await activity("exec", "call-1", "start");
  await progress.noteActivity({ startImmediately: true });
  rendered().toBe("Working");
  await progress.pushReasoningProgress("Checking the result");
  rendered().toContain("Checking the result");
  await progress.pushPlanProgress([{ step: "Verify", status: "in_progress" }]);
  rendered().toContain("In progress: Verify");
});

it("ignores late approval resolution after final delivery takes over", async () => {
  const deleteCurrent = vi.fn();
  const { progress, update } = createProgress({ label: false }, { deleteCurrent });
  await progress.pushApprovalEvent(approvalRequest);
  progress.markFinalReplyStarted();
  update.mockClear();
  await progress.pushApprovalEvent({ phase: "resolved", approvalId: "approval" });
  expect(update).not.toHaveBeenCalled();
  expect(deleteCurrent).not.toHaveBeenCalled();
});

it("flushes and retains approval attention through a full plan and activity", async () => {
  const maxLines = 1;
  const { progress, rendered, update } = createProgress({ ...commentary, maxLines });
  await progress.pushApprovalEvent(approvalRequest);
  expect(progress.hasStarted).toBe(true);
  rendered().toContain("Run checks");
  expect(update.mock.lastCall?.[1]).toMatchObject({ flush: true });
  await progress.pushPlanProgress(plan);
  for (let index = 0; index < 5; index++) {
    await progress.pushToolEvent({ name: "read", toolCallId: `call-${index}`, phase: "start" });
    await progress.pushCommentaryProgress(`Inspecting file ${index}`, {
      itemId: `comment-${index}`,
    });
    await progress.pushReasoningProgress(`Thinking ${index}`, { snapshot: true });
  }
  rendered().toContain("Run checks");
  expect(progress.getSnapshot().lines.length).toBeLessThanOrEqual(maxLines);
  expect(update.mock.lastCall?.[0].split("\n").filter(Boolean).length).toBeLessThanOrEqual(
    maxLines,
  );
  await progress.pushApprovalEvent({ phase: "resolved", approvalId: "approval" });
  rendered().not.toContain("Run checks");
});

it("keeps failed commands out of quiet summary plans", async () => {
  const maxLines = 3;
  const { progress, update, activity, rendered, lines } = createProgress(
    { ...commentary, maxLines },
    { presentation: "summary" },
  );
  await progress.pushPlanProgress(plan);
  const planText = update.mock.lastCall?.[0];
  await activity("exec", "failed-command", "result", { status: "failed" });
  rendered().toBe(planText);
  lines().toEqual([]);
  for (let index = 0; index < 5; index++) {
    await progress.pushToolEvent({ name: "read", toolCallId: `read-${index}`, phase: "start" });
    await progress.pushReasoningProgress(`Thinking ${index}`, { snapshot: true });
    rendered().not.toContain("failed");
    await progress.pushCommentaryProgress(`Inspecting file ${index}`, {
      itemId: `comment-${index}`,
    });
    rendered().not.toContain("failed");
  }
  expect(update.mock.lastCall?.[0].split("\n").filter(Boolean).length).toBeLessThanOrEqual(
    maxLines,
  );
  await activity("exec", "failed-command", "result", { status: "completed" });
  rendered().not.toContain("failed");
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
  const result = progress.pushToolProgress("Exec", { startImmediately: true });
  await started.promise;
  progress.markFinalReplyStarted();
  accepted.resolve(true);
  expect(await result).toBe(false);
  expect(progress).toMatchObject({ hasStarted: false, isVisible: false });
});

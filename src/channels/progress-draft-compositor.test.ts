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
    write: (toolCallId: string, path: string, content: string) =>
      progress.pushToolEvent({
        toolCallId,
        name: "write",
        phase: "start",
        args: { path, content },
      }),
    completeTool: (toolCallId: string) =>
      progress.pushItemEvent({ toolCallId, kind: "tool", phase: "end", status: "completed" }),
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
const tools = { toolProgress: true } as const;
const unlabeledTools = { ...tools, label: false } as const;
const prepared = { preparedItems: true };
const approvalRequest = {
  phase: "requested",
  approvalId: "approval",
  title: "Run checks",
} as const;
const lineWithId = (id: string) => expect.objectContaining({ id });
function expectText(text: string, included: string[], excluded: string[] = []) {
  included.forEach((value) => expect(text).toContain(value));
  excluded.forEach((value) => expect(text).not.toContain(value));
}
function createSnapshot(overrides: Partial<ChannelProgressDraftCompositorParams> = {}) {
  return createProgress(
    { ...commentary, maxLines: 8 },
    { ...prepared, seed: "snapshot", ...overrides },
  );
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("consecutive tool runs", () => {
  function setup(overrides: Partial<ChannelProgressDraftCompositorParams> = {}) {
    const { progress } = createProgress(
      { label: false, toolProgress: true, maxLines: 3 },
      { compactToolRuns: true, preparedItems: true, ...overrides },
    );
    const tool = (id: string, name = "bash", status = "running") =>
      progress.pushItemEvent({ itemId: `tool:${id}`, kind: "tool", name, status });
    const lines = () => progress.getSnapshot().lines;
    const labels = () => lines().map((line) => (typeof line === "string" ? line : line.label));
    const run = async (...ids: string[]) => {
      for (const id of ids) {
        await tool(id);
      }
    };
    return { progress, tool, run, lines, labels };
  }

  it("counts invocations beyond the row budget, not starts, ends or replays", async () => {
    const { progress, tool, labels } = setup();
    for (let index = 1; index <= 12; index++) {
      await tool(`${index}`);
      expect(labels()).toEqual([index === 1 ? "Bash" : `Bash ×${index}`]);
      await tool(`${index}`, "bash", "completed");
      await tool(`${index}`, "bash", "completed");
      expect(labels()).toEqual([index === 1 ? "Bash" : `Bash ×${index}`]);
    }
    await tool("other", "read");
    await tool("13");
    expect(labels()).toEqual(["Bash ×12", "Read", "Bash"]);
    await tool("1", "bash", "completed");
    expect(labels()).toEqual(["Bash ×12", "Read", "Bash"]);
    progress.markFinalReplyDelivered();
    expect(progress.beginNewTurn()).toBe(true);
    await tool("1");
    expect(labels()).toEqual(["Bash"]);
  });

  it("splits runs around late failures and keeps approvals and authored events", async () => {
    const { progress, tool, run, lines, labels } = setup();
    await run("1", "2", "3");
    await tool("2", "bash", "failed");
    expect(labels()).toEqual(["Bash ×2", "Bash"]);
    expect(lines().at(-1)).toMatchObject({ id: "tool:2", status: "failed" });
    await tool("4");
    expect(labels()).toEqual(["Bash ×2", "Bash", "Bash"]);
    await progress.pushApprovalEvent({ approvalId: "a1", phase: "requested", command: "printf x" });
    expect(lines().some((line) => typeof line === "object" && line.kind === "approval")).toBe(true);
    await tool("5");
    expect(labels().at(-1)).toBe("Bash");
    await progress.pushPreambleHeadline("Checking the next step", { itemId: "preamble-1" });
    await tool("6");
    expect(labels().slice(-2)).toEqual(["Bash", "Bash"]);
  });

  it("does not count unkeyed calls, detailed rows or colliding truncated titles", async () => {
    const { progress, tool, labels } = setup();
    await tool("1");
    await progress.pushToolProgress({
      kind: "tool",
      toolName: "bash",
      label: "Bash",
      text: "Bash",
    });
    await tool("2");
    expect(labels()).not.toContain("Bash ×2");
    const row = {
      kind: "tool" as const,
      toolName: "bash",
      label: "Bash",
      text: "Bash c",
      detail: "c",
    };
    await progress.pushToolProgress({ ...row, id: "detail-1" });
    await progress.pushToolProgress({ ...row, id: "detail-2" });
    expect(labels().slice(-2)).toEqual(["Bash", "Bash"]);
    const title = {
      kind: "item" as const,
      toolName: "api",
      label: "Same…title",
      text: "Same…title",
    };
    await progress.pushToolProgress({ ...title, id: "title-1" });
    await progress.pushToolProgress({ ...title, id: "title-2" });
    expect(labels().slice(-2)).toEqual(["Same…title", "Same…title"]);
  });

  it.each([1, 3])(
    "keeps new failures visible across run eviction with %i rows",
    async (maxLines) => {
      const { tool, run, lines, labels } = setup({
        entry: { streaming: { mode: "progress", progress: { toolProgress: true, maxLines } } },
      });
      await run("1", "2", "3");
      await tool("2", "bash", "failed");
      expect(lines().at(-1)).toMatchObject({ id: "tool:2", status: "failed" });
      await tool("read", "read");
      await tool("write", "write");
      await tool("1", "bash", "failed");
      expect(lines().at(-1)).toMatchObject({ id: "tool:1", status: "failed" });
      await tool("1", "bash", "failed");
      // Replays neither duplicate the failure nor resurrect the evicted run.
      expect(labels().filter((label) => label === "Bash")).toHaveLength(1);
      expect(labels()).not.toContain("Bash ×2");
      await tool("3", "bash", "completed");
      expect(lines().at(-1)).toMatchObject({ id: "tool:1", status: "failed" });
    },
  );

  it("retracts individual members without discarding the rest of a run", async () => {
    const { progress, run, labels } = setup();
    await run("1", "2", "3");
    await progress.pushItemEvent({ itemId: "tool:2", hideFromChannelProgress: true });
    expect(labels()).toEqual(["Bash ×2"]);
    await progress.pushItemEvent({ itemId: "tool:1", hideFromChannelProgress: true });
    expect(labels()).toEqual(["Bash"]);
  });

  it.each([
    { compactToolRuns: false },
    { mode: "partial" as const },
    {
      entry: {
        streaming: {
          mode: "progress" as const,
          progress: { toolProgress: true, commandText: "raw" as const },
        },
      },
    },
  ])("leaves non-target modes unchanged: %j", async (overrides) => {
    const { tool, labels } = setup(overrides);
    await tool("1");
    await tool("2");
    expect(labels()).toEqual(["Bash", "Bash"]);
  });

  // Shortened skill names are not identities, so even identical long names stay separate.
  const long = (middle: string) => `${"a".repeat(90)}${middle}${"z".repeat(90)}`;
  it.each([
    ["skills_read", "name", "github", "notion", "Skill Read: github ×2"],
    ["sessions_list", "limit", 30, 10, "Sessions: 30 ×2"],
    ["skills_read", "name", long("one"), long("two"), undefined],
  ] as const)("groups only identical safe %s details", async (name, key, same, other, text) => {
    const { progress, lines } = setup();
    const push = (id: string, value: unknown, isError = false) =>
      progress.pushItemEvent(
        projectAgentToolActivity({
          toolCallId: id,
          name,
          args: { [key]: value },
          phase: "result",
          isError,
        }),
      );
    await push("one", same);
    await push("two", same);
    expect(lines()[0]).toMatchObject({
      text: text ?? expect.not.stringContaining("×"),
    });
    await push("other", other);
    await push("fresh", same);
    expect(lines()).toHaveLength(3);
    await push("error", same, true);
    expect(lines().at(-1)).toMatchObject({ status: "failed" });
  });
});

it.each(["NO_REPLY", "_NO_REPLY_", "no_reply"])(
  "forwards prepared literal commentary: %s",
  async (text) => {
    const { progress, rendered } = createProgress({ ...quiet, commentary: true });
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

it("preserves the reasoning budget and italic markers with astral text", async () => {
  const { progress, rendered } = createProgress({ label: false, toolProgress: true });
  await progress.pushToolProgress("Exec", { startImmediately: true });
  await progress.pushReasoningProgress(`${"𠮷".repeat(40)} ${"x".repeat(100)}`);
  rendered().toBe(`• Exec\n• _${"𠮷".repeat(40)} ${"x".repeat(76)}…_`);
});

it.each([
  ["buffers tags", ["<thin", "k>Check</think>Answer"], "_Check_", true],
  ["literal code", ["```html\n<think>x</think>\n```"], "_```html <think>x</think> ```_", false],
  ["tilde code ownership", ["~~~html\n<think>x</think>\n~~~"], "x", false],
  ["snapshots", ["Thinking\n\n_A_", "Thinking\n\n_AB_"], "_AB_", false],
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
  rendered().toBe(`Shelling\n\n• Exec\n🧠 ${expected}`);
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
  const { progress, update } = createProgress(tools);
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
  const { progress, lines, activity, item } = createProgress(tools, prepared);
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
  const args = { action: "react", channel: "slack", target: "C000000001" };
  const { progress, activity, lines } = createProgress(tools, prepared);
  await progress.start();
  await activity("message", "message-1", "start", { args });
  lines().toEqual([]);
  await activity("message", "message-1", "result", { args, status: "failed" });
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
  const { progress, rendered, lines, write, completeTool } = createProgress(quiet, {
    updateOnLineChange: true,
  });
  await progress.pushPlanProgress([{ step: "Stale plan", status: "in_progress" }]);
  await write("write-1", "src/example.ts", "one\ntwo");
  expect(progress.getSnapshot().diffStat).toBeUndefined();
  await completeTool("write-1");
  expect(progress.getSnapshot().diffStat).toEqual({ files: 1, added: 2, removed: 0 });
  expect(await progress.pushPlanProgress([])).toBe(true);
  rendered().toContain("📝 1 files +2");
  rendered().not.toContain("Stale plan");
  lines().toEqual([]);
});

it("compares captured mutation totals without serializing unchanged progress", async () => {
  const diffStat = { files: 1, added: 2, removed: 0 };
  const started = createDeferred();
  const accepted = createDeferred<boolean>();
  const update = vi
    .fn<NonNullable<ChannelProgressDraftCompositorParams["update"]>>(() => true)
    .mockImplementationOnce(() => {
      started.resolve();
      return accepted.promise;
    });
  const { progress } = createProgress(
    { ...unlabeledTools, maxLines: 1 },
    { initialSnapshot: { lines: ["Exec"], diffStat }, updateOnLineChange: true, update },
  );
  const stringify = vi.spyOn(JSON, "stringify");
  const first = progress.noteActivity({ startImmediately: true });
  await started.promise;
  diffStat.added = 3;
  accepted.resolve(true);
  expect(await first).toBe(true);
  expect(await progress.pushToolProgress("Exec", { startImmediately: true })).toBe(true);
  expect(await progress.pushToolProgress("Exec", { startImmediately: true })).toBe(false);
  const serializedTotals = stringify.mock.calls.filter(([value]) => value === diffStat).length;
  stringify.mockRestore();
  expect(update.mock.calls.map(([text]) => text)).toEqual(["• Exec", "• Exec"]);
  expect(update.mock.lastCall?.[1].snapshot.diffStat).toEqual({ files: 1, added: 3, removed: 0 });
  expect(serializedTotals).toBe(0);
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
  const { progress } = createProgress(unlabeledTools, { tryNativeUpdate });
  await progress.pushPlanProgress([], {
    explanation: "Use **literal**.",
    explanationFormat: "plain",
  });
  await progress.pushToolProgress("Reading", { startImmediately: true });
  expect(tryNativeUpdate).toHaveBeenCalledWith(expect.stringContaining("Use **literal**."));
});

it("retains plans across partial message boundaries but clears them per turn", async () => {
  const { progress, item, update, rendered } = createProgress(unlabeledTools, { mode: "partial" });
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
  const { progress, activity, rendered } = createProgress(tools, { presentation: "summary" });
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

it("preserves public progress in rendering and snapshot capture", async () => {
  const secret = `sk-test-${"a".repeat(48)}`;
  const { progress, update } = createProgress(
    { ...commentary, label: `Account ${secret}` },
    { ...prepared, seed: "snapshot" },
  );
  await progress.start();
  await progress.pushPlanProgress([{ step: `Check account ${secret}`, status: "in_progress" }], {
    explanation: `Validate account ${secret}`,
  });
  await progress.pushNarrationProgress(`Inspect account ${secret}`);
  await progress.pushToolProgress({
    id: "public-tool",
    kind: "tool",
    text: secret,
    label: secret,
    detail: secret,
  });
  await progress.pushCommentaryProgress(`Checking account ${secret}`);
  const snapshot = progress.getSnapshot();
  expect(JSON.stringify(update.mock.calls)).toContain(secret);
  expect(progress.getText()).toContain(secret);
  expect(JSON.stringify(snapshot)).toContain(secret);
  expect(snapshot.plan?.[0]?.step).toContain("Check account");
  expect(update.mock.calls[0]?.[0]).toContain("Account");
});

it.each([true, false])("hydrates detached progress (live=%s)", async (live) => {
  const initialSnapshot = {
    label: "Parent label",
    lines: [
      { id: "commentary:parent", kind: "item" as const, text: "Parent note", label: "Note" },
      { id: "child", kind: "tool" as const, text: "Read", label: "Read", status: "running" },
    ],
    plan: plan.slice(0, 2),
    planExplanation: "Checking *literal* input",
    planExplanationFormat: "plain" as const,
    statusHeadline: "Transferred *headline*",
    statusHeadlineFormat: "plain" as const,
    preparedBlocks: [{ text: "Old transport markup", format: "markdown" as const }],
  };
  const update = vi.fn<NonNullable<ChannelProgressDraftCompositorParams["update"]>>(() => true);
  const { progress, item, lines } = createSnapshot({
    initialSnapshot,
    update: live ? update : undefined,
  });
  expect(update).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
  expect(progress).toMatchObject({ hasStarted: false, isVisible: false });
  await progress.noteActivity({ startImmediately: true });
  await item("tool", "child", { name: "read", status: "completed" });
  expect(progress).toMatchObject({ hasStarted: live, isVisible: live });
  expect(vi.getTimerCount()).toBe(0);
  expectText(
    progress.getText(),
    ["Parent label", "Parent note", "Inspect", "Repair", "Transferred \\*headline\\*"],
    ["Old transport markup"],
  );
  const childLines = progress
    .getSnapshot()
    .lines.filter((line) => typeof line === "object" && line.id === "child");
  expect(childLines).toEqual([expect.objectContaining({ status: "completed" })]);
  if (live) {
    expect(update.mock.lastCall?.[1].snapshot.preparedBlocks).toContainEqual({
      text: "Transferred *headline*",
      format: "plain",
    });
  }
  await progress.pushItemEvent({ itemId: "child", hideFromChannelProgress: true });
  lines().not.toContainEqual(lineWithId("child"));
  await progress.pushNarrationProgress("Child status");
  expectText(progress.getText(), ["Child status"], ["Transferred"]);
  expect(progress.getSnapshot().statusHeadlineFormat).toBeUndefined();
  await progress.pushNarrationProgress("");
  expect(progress.getText()).toContain("Checking \\*literal\\* input");
  expect(progress.getSnapshot().planExplanationFormat).toBe("plain");
});

it("applies privacy, quiet failures, approval priority and bounds to transferred lines", async () => {
  const { progress: parent, item: parentItem } = createSnapshot();
  await parent.pushPlanProgress([{ step: "Parent checklist", status: "in_progress" }]);
  await parentItem("tool", "private", { name: "read", title: "Sensitive row" });
  const approval = { approvalId: "approval", title: "Allow repair" };
  await parent.pushApprovalEvent({ ...approval, phase: "requested" });
  const initialSnapshot = parent.getSnapshot();
  parent.cancel();
  const { progress, update, item, lines } = createProgress(
    { ...quiet, commentary: true, maxLines: 2 },
    { ...prepared, seed: "snapshot", initialSnapshot },
  );
  await progress.noteActivity({ startImmediately: true });
  await progress.pushItemEvent({ itemId: "private", hideFromChannelProgress: true });
  lines().not.toContainEqual(lineWithId("private"));
  await item("tool", "failed", { name: "exec", status: "failed" });
  lines().not.toContainEqual(lineWithId("failed"));
  await progress.pushCommentaryProgress("Child note", { itemId: "child" });
  const text = update.mock.lastCall?.[0] ?? "";
  expectText(text, ["Allow repair", "Parent checklist"], ["Sensitive row", "failed"]);
  expect(text.split("\n").filter(Boolean)).toHaveLength(2);
  await progress.pushApprovalEvent({ ...approval, phase: "resolved" });
  expectText(update.mock.lastCall?.[0] ?? "", ["Child note"], ["Allow repair"]);
});

it("retains known mutation totals without inventing cross-owner file uniqueness", async () => {
  const { progress, write } = createSnapshot({
    initialSnapshot: { lines: [], diffStat: { files: 1, added: 2, removed: 1 } },
  });
  async function writeCompleted(toolCallId: string, path: string) {
    await write(toolCallId, path, "one\ntwo\nthree");
    await progress.pushItemEvent({ toolCallId, phase: "end", status: "completed" });
  }
  await writeCompleted("child-write", "possibly-the-parent-file.ts");
  expect(progress.getSnapshot().diffStat).toEqual({ files: 1, added: 2, removed: 1 });
  progress.resetActivity();
  expect(progress.getSnapshot().diffStat).toBeUndefined();
  await writeCompleted("next-write", "new-file.ts");
  expect(progress.getSnapshot().diffStat).toEqual({ files: 1, added: 3, removed: 0 });
});

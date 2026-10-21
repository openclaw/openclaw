import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import type { ChannelStreamingProgressConfig } from "../config/types.base.js";
import { createChannelProgressDraftCompositor } from "./progress-draft-compositor.js";
import type { ChannelProgressDraftCompositorParams } from "./progress-draft-compositor.types.js";
import type { ItemProgressPayload } from "./progress-draft-events.js";

function entry(progress: ChannelStreamingProgressConfig) {
  return { streaming: { mode: "progress" as const, progress } };
}
const createUpdate = () =>
  vi.fn<NonNullable<ChannelProgressDraftCompositorParams["update"]>>(() => true);
function toolItem(itemId: string, fields: Partial<ItemProgressPayload>) {
  return { itemId, kind: "tool", name: "read", ...fields };
}
const lineWithId = (id: string) => expect.objectContaining({ id });
function expectText(text: string, included: string[], excluded: string[] = []) {
  included.forEach((value) => expect(text).toContain(value));
  excluded.forEach((value) => expect(text).not.toContain(value));
}

function createProgress(overrides: Partial<ChannelProgressDraftCompositorParams> = {}) {
  const progress = createChannelProgressDraftCompositor({
    active: true,
    mode: "progress",
    seed: "snapshot",
    preparedItems: true,
    entry: entry({ label: false, commentary: true, toolProgress: true, maxLines: 8 }),
    update: () => true,
    ...overrides,
  });
  onTestFinished(() => progress.cancel());
  return progress;
}

afterEach(() => vi.useRealTimers());

it("preserves public progress in rendering and snapshot capture", async () => {
  const secret = `sk-test-${"a".repeat(48)}`;
  const update = createUpdate();
  const progress = createProgress({
    update,
    entry: entry({ label: `Account ${secret}`, commentary: true, toolProgress: true }),
  });
  await progress.start();
  await progress.pushPlanProgress([{ step: `Check account ${secret}`, status: "in_progress" }], {
    explanation: `Validate account ${secret}`,
  });
  await progress.pushNarrationProgress(`Inspect account ${secret}`);
  const publicFields = { text: secret, label: secret, detail: secret };
  await progress.pushToolProgress({ id: "public-tool", kind: "tool", ...publicFields });
  await progress.pushCommentaryProgress(`Checking account ${secret}`);
  const snapshot = progress.getSnapshot();
  expect(JSON.stringify(update.mock.calls)).toContain(secret);
  expect(progress.getText()).toContain(secret);
  expect(JSON.stringify(snapshot)).toContain(secret);
  expect(snapshot.plan?.[0]?.step).toContain("Check account");
  expect(update.mock.calls[0]?.[0]).toContain("Account");
});

it.each([true, false])("hydrates detached progress (live=%s)", async (live) => {
  vi.useFakeTimers();
  const initialSnapshot = {
    label: "Parent label",
    lines: [
      { id: "commentary:parent", kind: "item" as const, text: "Parent note", label: "Note" },
      { id: "child", kind: "tool" as const, text: "Read", label: "Read", status: "running" },
    ],
    plan: [
      { step: "Inspect", status: "completed" as const },
      { step: "Repair", status: "in_progress" as const },
    ],
    planExplanation: "Checking *literal* input",
    planExplanationFormat: "plain" as const,
    statusHeadline: "Transferred *headline*",
    statusHeadlineFormat: "plain" as const,
    preparedBlocks: [{ text: "Old transport markup", format: "markdown" as const }],
  };
  const update = createUpdate();
  const progress = createProgress({
    initialSnapshot,
    update: live ? update : undefined,
  });
  expect(update).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
  expect(progress).toMatchObject({ hasStarted: false, isVisible: false });
  await progress.noteActivity({ startImmediately: true });
  await progress.pushItemEvent(toolItem("child", { status: "completed" }));
  expect(progress).toMatchObject({ hasStarted: live, isVisible: live });
  expect(vi.getTimerCount()).toBe(0);
  const text = progress.getText();
  expectText(
    text,
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
  expect(progress.getSnapshot().lines).not.toContainEqual(lineWithId("child"));
  await progress.pushNarrationProgress("Child status");
  expectText(progress.getText(), ["Child status"], ["Transferred"]);
  expect(progress.getSnapshot().statusHeadlineFormat).toBeUndefined();
  await progress.pushNarrationProgress("");
  expect(progress.getText()).toContain("Checking \\*literal\\* input");
  expect(progress.getSnapshot().planExplanationFormat).toBe("plain");
});

it("applies privacy, quiet failures, approval priority and bounds to transferred lines", async () => {
  const parent = createProgress();
  await parent.pushPlanProgress([{ step: "Parent checklist", status: "in_progress" }]);
  await parent.pushItemEvent(toolItem("private", { title: "Sensitive row" }));
  const approval = { approvalId: "approval", title: "Allow repair" };
  await parent.pushApprovalEvent({ ...approval, phase: "requested" });
  const initialSnapshot = parent.getSnapshot();
  parent.cancel();
  const update = createUpdate();
  const progress = createProgress({
    initialSnapshot,
    update,
    entry: entry({ label: false, commentary: true, toolProgress: false, maxLines: 2 }),
  });
  await progress.noteActivity({ startImmediately: true });
  await progress.pushItemEvent({ itemId: "private", hideFromChannelProgress: true });
  expect(progress.getSnapshot().lines).not.toContainEqual(lineWithId("private"));
  await progress.pushItemEvent(toolItem("failed", { name: "exec", status: "failed" }));
  expect(progress.getSnapshot().lines).not.toContainEqual(lineWithId("failed"));
  await progress.pushCommentaryProgress("Child note", { itemId: "child" });
  const text = update.mock.lastCall?.[0] ?? "";
  expectText(text, ["Allow repair", "Parent checklist"], ["Sensitive row", "failed"]);
  expect(text.split("\n").filter(Boolean)).toHaveLength(2);
  await progress.pushApprovalEvent({ ...approval, phase: "resolved" });
  expectText(update.mock.lastCall?.[0] ?? "", ["Child note"], ["Allow repair"]);
});

it("retains known mutation totals without inventing cross-owner file uniqueness", async () => {
  const progress = createProgress({
    initialSnapshot: { lines: [], diffStat: { files: 1, added: 2, removed: 1 } },
  });
  async function write(toolCallId: string, path: string) {
    const args = { path, content: "one\ntwo\nthree" };
    await progress.pushToolEvent({ toolCallId, name: "write", phase: "start", args });
    await progress.pushItemEvent({ toolCallId, phase: "end", status: "completed" });
  }
  await write("child-write", "possibly-the-parent-file.ts");
  expect(progress.getSnapshot().diffStat).toEqual({ files: 1, added: 2, removed: 1 });
  progress.resetActivity();
  expect(progress.getSnapshot().diffStat).toBeUndefined();
  await write("next-write", "new-file.ts");
  expect(progress.getSnapshot().diffStat).toEqual({ files: 1, added: 3, removed: 0 });
});

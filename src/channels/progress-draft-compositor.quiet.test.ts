import { describe, expect, it, vi } from "vitest";
import { createChannelProgressDraftCompositor } from "./progress-draft-compositor.js";

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

describe("createChannelProgressDraftCompositor quiet drafts", () => {
  it("preserves the shipped summary presentation for external SDK callers", async () => {
    const update = vi.fn();
    const progress = createTestProgressDraftCompositor({
      presentation: "summary",
      entry: { streaming: { mode: "progress", progress: { toolProgress: true } } },
      update,
    });
    try {
      await progress.pushToolEvent({ name: "exec", toolCallId: "call-1", phase: "start" });
      await progress.noteActivity({ startImmediately: true });
      expect(update.mock.lastCall?.[0]).toBe("Working");
      await progress.pushReasoningProgress("Checking the result");
      expect(update.mock.lastCall?.[0]).toContain("Checking the result");
      await progress.pushPlanProgress([{ step: "Verify", status: "in_progress" }]);
      expect(update.mock.lastCall?.[0]).toContain("In progress: Verify");
    } finally {
      progress.cancel();
    }
  });

  it("ignores late approval resolution after the final reply takes over", async () => {
    const update = vi.fn();
    const deleteCurrent = vi.fn();
    const progress = createTestProgressDraftCompositor({
      entry: { streaming: { mode: "progress", progress: { label: false } } },
      update,
      deleteCurrent,
    });
    await progress.pushApprovalEvent({
      phase: "requested",
      approvalId: "approval-1",
      title: "Run checks",
    });
    progress.markFinalReplyStarted();
    update.mockClear();
    await progress.pushApprovalEvent({ phase: "resolved", approvalId: "approval-1" });
    expect(update).not.toHaveBeenCalled();
    expect(deleteCurrent).not.toHaveBeenCalled();
    progress.cancel();
  });

  it("keeps a quiet draft stable across tool activity when the tool log is off", async () => {
    const update = vi.fn();
    const progress = createTestProgressDraftCompositor({
      entry: { streaming: { mode: "progress" } },
      update,
    });
    await progress.pushPreambleHeadline("Checking source 🔎");
    await progress.noteActivity({ startImmediately: true });
    for (let index = 0; index < 20; index++) {
      await progress.pushToolEvent({ name: "exec", toolCallId: `call-${index}`, phase: "start" });
    }
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0]?.[0]).toBe("Checking source 🔎");
    await progress.pushPlanProgress([{ step: "Verify behavior", status: "in_progress" }]);
    expect(update.mock.lastCall?.[0]).toBe("Checking source 🔎\n\n▸ Verify behavior");
    progress.cancel();
  });

  it("opts back into the tool log with progress.toolProgress", async () => {
    const update = vi.fn();
    const progress = createTestProgressDraftCompositor({
      entry: { streaming: { mode: "progress", progress: { toolProgress: true } } },
      update,
    });
    await progress.pushToolEvent({ name: "exec", toolCallId: "call-1", phase: "start" });
    await progress.noteActivity({ startImmediately: true });
    expect(update.mock.lastCall?.[0]).toContain("🛠️ Exec");
    progress.cancel();
  });

  it.each([false, true])(
    "flushes approval attention before startup and clears it once resolved (toolProgress=%s)",
    async (toolProgress) => {
      const update = vi.fn();
      const progress = createTestProgressDraftCompositor({
        entry: { streaming: { mode: "progress", progress: { toolProgress } } },
        update,
      });
      try {
        await progress.pushApprovalEvent({
          phase: "requested",
          approvalId: "approval-1",
          title: "Run checks",
        });
        expect(progress.hasStarted).toBe(true);
        expect(update.mock.lastCall?.[0]).toContain("Run checks");
        expect(update.mock.lastCall?.[1]).toMatchObject({ flush: true });
        for (let index = 0; index < 20; index++) {
          await progress.pushToolEvent({
            name: "read",
            toolCallId: `call-${index}`,
            phase: "start",
          });
        }
        expect(update.mock.lastCall?.[0]).toContain("Run checks");
        await progress.pushApprovalEvent({ phase: "resolved", approvalId: "approval-1" });
        expect(update.mock.lastCall?.[0]).not.toContain("Run checks");
        if (!toolProgress) {
          expect(update.mock.lastCall?.[0]).toBe("Working");
        }
      } finally {
        progress.cancel();
      }
    },
  );

  it.each([
    { toolProgress: false, maxLines: 1 },
    { toolProgress: false, maxLines: 3 },
    { toolProgress: true, maxLines: 1 },
    { toolProgress: true, maxLines: 3 },
  ])(
    "retains attention with a full plan and later activity ($toolProgress, $maxLines)",
    async ({ toolProgress, maxLines }) => {
      const update = vi.fn();
      const progress = createTestProgressDraftCompositor({
        entry: {
          streaming: {
            mode: "progress",
            progress: { toolProgress, maxLines, commentary: true, label: false },
          },
        },
        update,
      });
      try {
        await progress.pushPlanProgress([
          { step: "Inspect", status: "completed" },
          { step: "Patch", status: "in_progress" },
          { step: "Verify", status: "pending" },
        ]);
        await progress.pushApprovalEvent({
          phase: "requested",
          approvalId: "approval-1",
          title: "Run checks",
        });
        expect(update.mock.lastCall?.[0]).toContain("Run checks");
        expect(update.mock.lastCall?.[1]).toMatchObject({ flush: true });
        for (let index = 0; index < 5; index++) {
          await progress.pushToolEvent({
            name: "read",
            toolCallId: `call-${index}`,
            phase: "start",
          });
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
        await progress.pushApprovalEvent({ phase: "resolved", approvalId: "approval-1" });
        expect(update.mock.lastCall?.[0]).not.toContain("Run checks");
      } finally {
        progress.cancel();
      }
    },
  );

  it.each([undefined, false, true])(
    "only starts a failed-command draft with tool progress enabled (%s)",
    async (toolProgress) => {
      const update = vi.fn();
      const progress = createTestProgressDraftCompositor({
        entry: {
          streaming: {
            mode: "progress",
            progress: { toolProgress, maxLines: 3, label: false },
          },
        },
        update,
      });
      try {
        await progress.pushCommandOutputEvent({
          phase: "end",
          toolCallId: "failed-command",
          exitCode: 1,
        });
        expect(progress.hasStarted).toBe(toolProgress === true);
        if (toolProgress) {
          expect(update.mock.lastCall?.[0]).toContain("exit 1");
          expect(update.mock.lastCall?.[1]).toMatchObject({ flush: true });
        } else {
          expect(update).not.toHaveBeenCalled();
          expect(progress.getSnapshot().lines).toEqual([]);
        }
      } finally {
        progress.cancel();
      }
    },
  );

  it.each([
    { presentation: undefined, toolProgress: false, maxLines: 1 },
    { presentation: undefined, toolProgress: false, maxLines: 3 },
    { presentation: "summary" as const, toolProgress: false, maxLines: 1 },
    { presentation: "summary" as const, toolProgress: true, maxLines: 3 },
  ])(
    "keeps failed commands out of quiet plans through reasoning and commentary ($presentation, $toolProgress, $maxLines)",
    async ({ presentation, toolProgress, maxLines }) => {
      const update = vi.fn();
      const progress = createTestProgressDraftCompositor({
        presentation,
        entry: {
          streaming: {
            mode: "progress",
            progress: { toolProgress, maxLines, commentary: true, label: false },
          },
        },
        update,
      });
      try {
        await progress.pushPlanProgress([
          { step: "Inspect", status: "completed" },
          { step: "Repair", status: "in_progress" },
          { step: "Verify", status: "pending" },
        ]);
        const planText = update.mock.lastCall?.[0];
        await progress.pushCommandOutputEvent({
          phase: "end",
          toolCallId: "failed-command",
          exitCode: 1,
        });
        expect(update.mock.lastCall?.[0]).toBe(planText);
        expect(progress.getSnapshot().lines).toEqual([]);
        for (let index = 0; index < 5; index++) {
          await progress.pushToolEvent({
            name: "read",
            toolCallId: `read-${index}`,
            phase: "start",
          });
          await progress.pushReasoningProgress(`Thinking ${index}`, { snapshot: true });
          expect(update.mock.lastCall?.[0]).not.toContain("exit 1");
          await progress.pushCommentaryProgress(`Inspecting file ${index}`, {
            itemId: `comment-${index}`,
          });
          expect(update.mock.lastCall?.[0]).not.toContain("exit 1");
        }
        expect(update.mock.lastCall?.[0].split("\n").filter(Boolean).length).toBeLessThanOrEqual(
          maxLines,
        );
        await progress.pushCommandOutputEvent({
          phase: "end",
          toolCallId: "failed-command",
          exitCode: 0,
        });
        expect(update.mock.lastCall?.[0]).not.toContain("exit 1");
      } finally {
        progress.cancel();
      }
    },
  );

  it.each([
    {
      order: "tool item, then command output",
      failures: ["tool", "command"],
      recovery: "command",
    },
    {
      order: "command output, then tool item",
      failures: ["command", "tool"],
      recovery: "tool",
    },
  ] as const)(
    "hides quiet failures across tool item and command output events ($order)",
    async ({ failures, recovery }) => {
      const update = vi.fn();
      const progress = createTestProgressDraftCompositor({
        entry: {
          streaming: {
            mode: "progress",
            progress: { toolProgress: false, maxLines: 3, commentary: true, label: false },
          },
        },
        update,
      });
      // Providers can report the same failure through both event families.
      const push = (family: "tool" | "command", outcome: "failed" | "completed") =>
        family === "tool"
          ? progress.pushItemEvent({
              itemId: "tool:call-1",
              toolCallId: "call-1",
              kind: "tool",
              name: "exec",
              status: outcome,
            })
          : progress.pushCommandOutputEvent({
              phase: "end",
              itemId: "command:call-1",
              toolCallId: "call-1",
              exitCode: outcome === "failed" ? 1 : 0,
            });
      try {
        await progress.pushPlanProgress([
          { step: "Inspect", status: "completed" },
          { step: "Repair", status: "in_progress" },
        ]);
        for (const family of failures) {
          await push(family, "failed");
          expect(update.mock.lastCall?.[0]).not.toMatch(/failed|exit 1/);
        }
        expect(progress.getSnapshot().lines).toHaveLength(0);
        await push(recovery, "completed");
        expect(update.mock.lastCall?.[0]).toContain("Repair");
        expect(update.mock.lastCall?.[0]).not.toMatch(/failed|exit 1/);
        expect(update.mock.lastCall?.[1]?.lines).toHaveLength(0);
      } finally {
        progress.cancel();
      }
    },
  );

  it.each(["failed", "error", "blocked"])(
    "flushes and retains explicit %s status while tool progress is enabled",
    async (status) => {
      const update = vi.fn();
      const progress = createTestProgressDraftCompositor({
        entry: {
          streaming: {
            mode: "progress",
            progress: { toolProgress: true, maxLines: 3, commentary: true, label: false },
          },
        },
        update,
      });
      try {
        await progress.pushPlanProgress([
          { step: "Inspect", status: "completed" },
          { step: "Repair", status: "in_progress" },
          { step: "Verify", status: "pending" },
        ]);
        await progress.pushItemEvent({
          itemId: "attention-item",
          kind: "tool",
          name: "read",
          status,
          progressText: "Check access",
        });
        expect(update.mock.lastCall?.[0]).toContain("Check access");
        expect(update.mock.lastCall?.[1]).toMatchObject({ flush: true });
        for (let index = 0; index < 5; index++) {
          await progress.pushToolEvent({
            name: "read",
            toolCallId: `read-${index}`,
            phase: "start",
          });
          await progress.pushCommentaryProgress(`Inspecting file ${index}`, {
            itemId: `comment-${index}`,
          });
        }
        expect(update.mock.lastCall?.[0]).toContain("Check access");
        expect(update.mock.lastCall?.[0].split("\n").filter(Boolean).length).toBeLessThanOrEqual(3);
      } finally {
        progress.cancel();
      }
    },
  );

  it("lets new activity replace old non-zero exits without collapsing the plan", async () => {
    const update = vi.fn();
    const progress = createTestProgressDraftCompositor({
      entry: {
        streaming: {
          mode: "progress",
          progress: { toolProgress: true, maxLines: 8, commentary: true, label: false },
        },
      },
      update,
    });
    try {
      await progress.pushPlanProgress([
        { step: "Inspect", status: "completed" },
        { step: "Repair", status: "in_progress" },
        { step: "Verify", status: "pending" },
        { step: "Audit", status: "pending" },
        { step: "Ship", status: "pending" },
      ]);
      for (let index = 1; index <= 8; index++) {
        await progress.pushCommandOutputEvent({
          phase: "end",
          toolCallId: `failed-${index}`,
          exitCode: index,
        });
      }
      await progress.pushToolEvent({ name: "read", toolCallId: "new-work", phase: "start" });

      const rendered = update.mock.lastCall?.[0] ?? "";
      for (const step of ["Inspect", "Repair", "Verify", "Audit", "Ship"]) {
        expect(rendered).toContain(step);
      }
      expect(rendered).toContain("Read");
      expect(rendered).not.toContain("exit 1");
      expect(progress.getSnapshot().lines).toHaveLength(8);
    } finally {
      progress.cancel();
    }
  });
});

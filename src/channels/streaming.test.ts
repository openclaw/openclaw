import { describe, expect, it } from "vitest";
import { inferToolMetaFromArgsCore } from "../agents/tool-display.js";
import { formatToolAggregate } from "../auto-reply/tool-meta.js";
import { createChannelProgressDraftCompositor } from "./progress-draft-compositor.js";
import {
  type ChannelProgressDraftLineInput,
  buildChannelProgressDraftLine,
  buildChannelProgressDraftLineForEntry,
  formatChannelProgressDraftLineForEntry,
  formatChannelProgressDraftText,
  formatPlanChecklistLines,
  normalizeAgentPlanSteps,
  isChannelProgressPriorityLine,
  mergeChannelProgressDraftLine,
  resolveChannelStreamingBlockEnabled,
  resolveChannelStreamingProgressCommentary,
  resolveChannelStreamingProgressNarration,
} from "./streaming.js";

describe("buildChannelProgressDraftLine", () => {
  it("lets named failed command items scroll out while retaining attention", () => {
    const line = buildChannelProgressDraftLine({
      event: "item",
      itemKind: "command",
      name: "exec",
      status: "failed",
    });
    expect(line).toBeDefined();
    expect(isChannelProgressPriorityLine(line!)).toBe(false);
    expect(isChannelProgressPriorityLine({ ...line!, status: "blocked" })).toBe(true);
    expect(isChannelProgressPriorityLine({ ...line!, status: "error" })).toBe(true);
    expect(isChannelProgressPriorityLine({ ...line!, kind: "approval" })).toBe(true);
    expect(isChannelProgressPriorityLine({ ...line!, toolName: undefined })).toBe(true);
    expect(isChannelProgressPriorityLine({ ...line!, kind: "tool" })).toBe(true);
  });

  it("keeps prepared titles and failure outcomes when detail text is unchanged", () => {
    const input = {
      event: "item" as const,
      itemKind: "tool",
      itemId: "task",
      name: "process",
      title: "Check sample results",
      progressText: "sample job",
    };
    const running = formatChannelProgressDraftLineForEntry(undefined, {
      ...input,
      status: "running",
    });
    const failed = formatChannelProgressDraftLineForEntry(undefined, {
      ...input,
      status: "failed",
    });
    expect(running).toContain("Check sample results");
    expect(failed).toContain("Check sample results");
    expect(failed).toContain("failed");
    expect(failed).toContain("sample job");
    expect(failed).not.toBe(running);
  });

  it("keeps plan arguments out of generic tool and item rows", () => {
    const name = "progress_card";
    const args = {
      markdown: '<progress aria-label="CI · 2/3" value="2" max="3"></progress>',
      plan: [{ step: "Inspect", status: "in_progress" }],
    };
    expect(buildChannelProgressDraftLine({ event: "tool", name, args })).toBeUndefined();
    expect(
      buildChannelProgressDraftLine({
        event: "item",
        itemKind: "tool",
        name,
        meta: args.markdown,
      }),
    ).toBeUndefined();
  });

  it("keeps blocked plan-tool attention without raw argument metadata", () => {
    expect(
      buildChannelProgressDraftLine({
        event: "item",
        itemId: "plan-failed",
        itemKind: "tool",
        name: "progress_card",
        status: "blocked",
        meta: '<progress aria-label="private" value="1" max="2"></progress>',
      }),
    ).toMatchObject({
      id: "plan-failed",
      kind: "item",
      label: "Progress Card",
      status: "blocked",
      text: "🗺️ Progress Card",
    });
  });

  it("defaults entry-backed command progress to status and preserves explicit raw text", () => {
    const input = {
      event: "tool" as const,
      name: "exec",
      phase: "start",
      args: { command: "echo private" },
    };

    expect(buildChannelProgressDraftLineForEntry(undefined, input)?.text).toBe("🛠️ Exec");
    expect(
      buildChannelProgressDraftLineForEntry(
        { streaming: { progress: { commandText: "raw" } } },
        input,
        { detailMode: "raw" },
      )?.text,
    ).toContain("echo private");

    const commandOutput = {
      event: "command-output" as const,
      name: "exec",
      phase: "end",
      title: "echo private",
      exitCode: 1,
    };
    expect(buildChannelProgressDraftLine(commandOutput)?.text).toBe("🛠️ exit 1");
    expect(buildChannelProgressDraftLine(commandOutput, { commandText: "raw" })?.text).toContain(
      "echo private",
    );

    const item = {
      event: "item" as const,
      itemKind: "command",
      name: "exec",
      phase: "start",
      status: "running",
      meta: "echo private",
    };
    expect(buildChannelProgressDraftLine(item)?.text).toBe("🛠️ Exec");
    expect(buildChannelProgressDraftLine(item, { commandText: "raw" })?.text).toContain(
      "echo private",
    );

    const namespaced = { ...input, name: "server.exec" };
    expect(buildChannelProgressDraftLineForEntry(undefined, namespaced)?.text).not.toContain(
      "echo private",
    );
    expect(
      buildChannelProgressDraftLineForEntry(
        { streaming: { progress: { commandText: "raw" } } },
        namespaced,
      )?.text,
    ).toContain("echo private");
  });
});

describe("backend tool-name casing", () => {
  it("renders capitalized shell tools and their summary as one line without duplicate icons", () => {
    const name = "Bash";
    const args = { command: "echo alpha", description: "print text" };
    const structured = buildChannelProgressDraftLine(
      {
        event: "tool",
        toolCallId: "call-1",
        name,
        phase: "start",
        args,
      },
      { commandText: "raw" },
    );
    const meta = inferToolMetaFromArgsCore(name, args, { detailMode: "explain" });
    const summaryText = formatToolAggregate(name, meta ? [meta] : undefined, { markdown: true });

    const merged = mergeChannelProgressDraftLine(
      structured ? [structured] : [],
      { kind: "item", label: "", text: summaryText, prefix: false },
      { maxLines: 8 },
    );

    expect(merged).toHaveLength(1);
    expect(structured?.detail).toBe("print text");
    expect(structured?.text).toBe("🛠️ print text");
  });
});

describe("mergeChannelProgressDraftLine", () => {
  it("preserves SDK default retention of non-zero exits over newer activity", () => {
    const exit = {
      id: "command-1",
      kind: "command-output" as const,
      label: "Exec",
      text: "🛠️ exit 1",
      status: "exit 1",
    };
    const lines = mergeChannelProgressDraftLine(
      [exit, { id: "read-1", kind: "tool", label: "Read", text: "Read first file" }],
      { id: "read-2", kind: "tool", label: "Read", text: "Read second file" },
      { maxLines: 2 },
    );

    expect(lines.map((line) => line.text)).toEqual(["🛠️ exit 1", "Read second file"]);
  });
});

describe("normalizeAgentPlanSteps", () => {
  it("normalizes external-plugin string steps and typed entries, dropping blanks", () => {
    expect(
      normalizeAgentPlanSteps([
        "Inspect",
        "  ",
        { step: "  Patch  ", status: "in_progress" },
        { step: "   ", status: "pending" },
        { step: "Test", status: "bogus" },
      ]),
    ).toEqual([
      { step: "Inspect", status: "pending" },
      { step: "Patch", status: "in_progress" },
    ]);
    expect(normalizeAgentPlanSteps(undefined)).toBeUndefined();
  });
});

describe("streaming config resolution", () => {
  it("lets an available explicit preview override the inherited block default", () => {
    expect(
      resolveChannelStreamingBlockEnabled(
        { streaming: { mode: "partial" } },
        { previewAvailable: true, blockStreamingDefault: "on" },
      ),
    ).toBe(false);
  });

  it("keeps the inherited block default for off or invalid preview modes", () => {
    expect(
      resolveChannelStreamingBlockEnabled(
        { streaming: { mode: "off" } },
        {
          previewAvailable: true,
          blockStreamingDefault: "on",
        },
      ),
    ).toBe(true);
    expect(
      resolveChannelStreamingBlockEnabled(
        { streaming: { mode: "invalid" } },
        {
          previewAvailable: true,
          blockStreamingDefault: "on",
        },
      ),
    ).toBe(true);
  });
});

describe("progress narration", () => {
  const plan = [
    { step: "Inspect", status: "completed" },
    { step: "Patch", status: "in_progress" },
    { step: "Verify", status: "pending" },
  ] as const;

  it.each([undefined, "summary"] as const)(
    "preserves SDK default exit priority over a full plan (presentation=%s)",
    (presentation) => {
      const text = formatChannelProgressDraftText({
        presentation,
        entry: {
          streaming: {
            mode: "progress",
            progress: { toolProgress: true, label: false, maxLines: 3 },
          },
        },
        lines: [{ kind: "command-output", label: "Exec", text: "🛠️ exit 1", status: "exit 1" }],
        plan,
      });

      expect(text).toContain("exit 1");
      expect(text).toContain("Patch");
      expect(text.split("\n").filter(Boolean)).toHaveLength(3);
    },
  );

  it("preserves the shipped plain checklist option", () => {
    expect(formatPlanChecklistLines(plan, { maxLines: 3, maxLineChars: 80, plain: true })).toEqual([
      "Completed: Inspect",
      "In progress: Patch",
      "Pending: Verify",
    ]);
  });

  it("renders plan markers and keeps the checklist under narration", () => {
    expect(formatPlanChecklistLines(plan, { maxLines: 5, maxLineChars: 80 })).toEqual([
      "✅ Inspect",
      "▸ Patch",
      "▢ Verify",
    ]);
    expect(
      formatChannelProgressDraftText({
        entry: { streaming: { mode: "progress", progress: { label: false } } },
        lines: ["🛠️ Exec"],
        narration: "Working through the plan.",
        plan,
      }),
    ).toBe("Working through the plan.\n\n🛠️ Exec\n✅ Inspect\n▸ Patch\n▢ Verify");
  });

  it("uses only a summary when the checklist has one line available", () => {
    expect(formatPlanChecklistLines(plan, { maxLines: 1, maxLineChars: 80 })).toEqual([
      "✅ 1/3 done",
    ]);
  });

  it("keeps the active step when later pending work fills the checklist", () => {
    expect(
      formatPlanChecklistLines(
        [
          { step: "Done", status: "completed" },
          { step: "Active", status: "in_progress" },
          { step: "Next", status: "pending" },
          { step: "Later", status: "pending" },
          { step: "Last", status: "pending" },
        ],
        { maxLines: 3, maxLineChars: 80 },
      ),
    ).toEqual(["✅ 1/5 done", "▸ Active", "▢ Last"]);
  });

  it("shares the line budget between tool progress and the checklist", () => {
    expect(
      formatChannelProgressDraftText({
        entry: {
          streaming: { mode: "progress", progress: { label: false, maxLines: 3 } },
        },
        lines: ["tool one", "tool two", "tool three"],
        plan: [
          { step: "Active", status: "in_progress" },
          { step: "Next", status: "pending" },
        ],
      }),
    ).toBe("• tool three\n▸ Active\n▢ Next");
  });

  it("drops every tool line when the checklist consumes the whole budget", () => {
    expect(
      formatChannelProgressDraftText({
        entry: {
          streaming: { mode: "progress", progress: { label: false, maxLines: 2 } },
        },
        lines: ["tool one", "tool two"],
        plan: [
          { step: "Active", status: "in_progress" },
          { step: "Next", status: "pending" },
        ],
      }),
    ).toBe("▸ Active\n▢ Next");
  });

  it("honors the caller's mode when resolving commentary", () => {
    // The progress-draft channels default to "progress" when streaming.mode is
    // unset, so guessing "partial" here made progress.commentary a silent no-op.
    const entry = { streaming: { progress: { commentary: true } } };
    expect(resolveChannelStreamingProgressCommentary(entry, false, "progress")).toBe(true);
    expect(resolveChannelStreamingProgressCommentary(entry, false, "partial")).toBe(false);
    expect(
      resolveChannelStreamingProgressCommentary(
        { streaming: { mode: "progress", progress: { commentary: true } } },
        false,
      ),
    ).toBe(true);
  });

  it("resolves the narration toggle with default on", () => {
    // Mode gating is the caller's job; unset config keeps narration available.
    expect(resolveChannelStreamingProgressNarration(undefined)).toBe(true);
    expect(resolveChannelStreamingProgressNarration({ streaming: { mode: "progress" } })).toBe(
      true,
    );
    expect(
      resolveChannelStreamingProgressNarration({
        streaming: { mode: "progress", progress: { narration: false } },
      }),
    ).toBe(false);
  });
});

type CommandInput = Extract<
  ChannelProgressDraftLineInput,
  { event: "tool" | "item" | "command-output" }
>;

function buildLine(input: CommandInput, markdown = false) {
  const line = buildChannelProgressDraftLine(
    { toolCallId: "call-1", name: "exec", ...input },
    { commandText: "raw", markdown },
  );
  if (!line) {
    throw new Error("expected command progress");
  }
  return line;
}

// Preserve the producer's order: terminal items precede the titled command output.
function commandSequence(status: "failed" | "completed", exitCode: number): CommandInput[] {
  const item = { event: "item" as const, meta: "run tests · pty · elevated" };
  const tool = {
    ...item,
    itemId: "tool:call-1",
    itemKind: "tool",
    title: `exec ${item.meta}`,
    commandBearing: true,
  };
  const command = {
    ...item,
    itemId: "command:call-1",
    itemKind: "command",
    title: `command ${item.meta}`,
  };
  const output = { event: "command-output" as const, phase: "end", status, exitCode };
  return [
    { event: "tool", itemId: tool.itemId, phase: "start", args: { command: "pnpm test" } },
    { ...tool, phase: "start", status: "running" },
    { ...command, phase: "start", status: "running" },
    output,
    { ...tool, phase: "end", status },
    { ...command, phase: "end", status, summary: "3 tests failed" },
    { ...output, itemId: command.itemId, title: command.title },
  ];
}

describe("channel-streaming embedded command items", () => {
  it.each([
    { status: "failed", exitCode: 1, markdown: true, finalStatus: "exit 1" },
    { status: "completed", exitCode: 0, markdown: false, finalStatus: "completed" },
  ] as const)("keeps one command row through terminal delivery ($status)", async (params) => {
    const commandText = params.markdown ? "`run tests`" : "run tests";
    const detail = `pty · elevated · ${commandText}`;
    let rendered = "";
    const progress = createChannelProgressDraftCompositor({
      active: true,
      mode: "progress",
      seed: "command-correlation",
      entry: { streaming: { progress: { label: false, toolProgress: true, maxLines: 4 } } },
      update: (text) => {
        rendered = text;
        return true;
      },
    });
    try {
      const inputs = commandSequence(params.status, params.exitCode);
      for (const [index, input] of inputs.entries()) {
        await progress.pushToolProgress(buildLine(input, params.markdown));
        const lines = progress.getSnapshot().lines;
        expect(lines, `event ${index}`).toHaveLength(1);
        expect(lines[0], `event ${index}`).toMatchObject({
          id: "tool:call-1",
          detail: index === 0 ? commandText : detail,
        });
      }
      await progress.start();
      expect(progress.getSnapshot().lines[0]).toMatchObject({
        kind: "command-output",
        detail,
        status: params.finalStatus,
        text: `🛠️ ${params.exitCode === 0 ? "" : "exit 1; "}${detail}`,
      });
      expect(rendered.match(/run tests/g)).toHaveLength(1);
    } finally {
      progress.cancel();
    }
  });

  it("keeps a flagged output title when it describes different work", () => {
    const previous = buildLine({
      event: "item",
      itemId: "command:call-1",
      itemKind: "command",
      status: "running",
      meta: "inspect files · pty",
    });
    const output = buildLine({
      event: "command-output",
      itemId: "command:call-1",
      phase: "end",
      title: "command run tests · pty",
      exitCode: 0,
    });
    expect(mergeChannelProgressDraftLine([previous], output, { maxLines: 4 })[0]?.detail).toBe(
      "pty · command run tests",
    );
    expect(mergeChannelProgressDraftLine([], output, { maxLines: 4 })[0]?.detail).toBe(
      "pty · command run tests",
    );
  });

  it("replaces a terminal failure when recovered output names no command", () => {
    const endedLine = buildLine({
      event: "item",
      itemId: "command:call-1",
      itemKind: "command",
      phase: "end",
      status: "failed",
      progressText: "install dependencies failed",
    });
    const recoveredOutput = buildLine({
      event: "command-output",
      itemId: "command:call-1",
      phase: "end",
      exitCode: 0,
    });
    expect(endedLine.detail).toBe("install dependencies failed");
    const merged = mergeChannelProgressDraftLine([endedLine], recoveredOutput, { maxLines: 4 });
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ kind: "command-output", status: "completed" });
    expect(merged[0]).not.toHaveProperty("detail");
  });
});
